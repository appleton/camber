package localinference

import (
	"fmt"
	"math"
	"os/exec"
	"runtime"
	"strconv"
	"strings"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

type machineProfile struct {
	Supported   bool
	OS          string
	Arch        string
	MemoryBytes int64
}

func currentMachineProfile() machineProfile {
	cachedMachineProfileOnce.Do(func() {
		cachedMachineProfile = machineProfile{
			Supported: localRuntimeSupported(),
			OS:        runtime.GOOS,
			Arch:      runtime.GOARCH,
		}
		if runtime.GOOS == "darwin" {
			output, err := exec.Command("sysctl", "-n", "hw.memsize").Output()
			if err == nil {
				memory, parseErr := strconv.ParseInt(strings.TrimSpace(string(output)), 10, 64)
				if parseErr == nil && memory > 0 {
					cachedMachineProfile.MemoryBytes = memory
				}
			}
		}
	})
	return cachedMachineProfile
}

func decorateModelRunEstimate(model *methods.LocalInferenceModel, machine machineProfile, download *methods.LocalInferenceDownloadState) {
	estimate := estimateRunFit(*model, machine, download)
	model.RunEstimate = &estimate
}

func estimateRunFit(model methods.LocalInferenceModel, machine machineProfile, download *methods.LocalInferenceDownloadState) methods.LocalInferenceRunEstimate {
	if !machine.Supported {
		return methods.LocalInferenceRunEstimate{
			Confidence:         methods.LocalInferenceRunConfidenceLow,
			Summary:            "Low: local MLX inference requires an Apple Silicon Mac",
			MachineMemoryBytes: machine.MemoryBytes,
			Details: []string{
				fmt.Sprintf("Machine: %s/%s", machine.OS, machine.Arch),
				"Reason: MLX local inference is only enabled on Apple Silicon Macs.",
			},
		}
	}

	weightBytes, weightDetail := estimateWeightBytes(model, download)
	parameterCount := estimateParameterCount(model.ParameterSize)
	kvBytes := estimateKVCacheBytes(parameterCount, model.ContextWindow)
	overheadBytes := int64(1 * 1024 * 1024 * 1024)
	estimatedBytes := weightBytes + kvBytes + overheadBytes
	machineDetail := fmt.Sprintf("Machine: %s unified memory", formatBytesIEC(machine.MemoryBytes))
	if machine.MemoryBytes <= 0 {
		machineDetail = "Machine: unified memory could not be detected."
	}
	details := []string{
		machineDetail,
		weightDetail,
		fmt.Sprintf("KV cache: %s", formatBytesIEC(kvBytes)),
		fmt.Sprintf("Runtime overhead: %s", formatBytesIEC(overheadBytes)),
	}

	if machine.MemoryBytes <= 0 {
		return methods.LocalInferenceRunEstimate{
			Confidence:           methods.LocalInferenceRunConfidenceLow,
			Summary:              "Low: machine memory could not be detected",
			EstimatedMemoryBytes: estimatedBytes,
			WeightBytes:          weightBytes,
			KVCacheBytes:         kvBytes,
			OverheadBytes:        overheadBytes,
			Details:              details,
		}
	}
	if weightBytes <= 0 {
		return methods.LocalInferenceRunEstimate{
			Confidence:           methods.LocalInferenceRunConfidenceLow,
			Summary:              "Low: model size metadata is missing",
			EstimatedMemoryBytes: estimatedBytes,
			MachineMemoryBytes:   machine.MemoryBytes,
			WeightBytes:          weightBytes,
			KVCacheBytes:         kvBytes,
			OverheadBytes:        overheadBytes,
			Details:              details,
		}
	}

	ratio := float64(estimatedBytes) / float64(machine.MemoryBytes)
	details = append(details, fmt.Sprintf("Estimated peak: %s, %.0f%% of unified memory.", formatBytesIEC(estimatedBytes), ratio*100))

	confidence := methods.LocalInferenceRunConfidenceLow
	summary := "Low: estimated memory is likely above local limits"
	switch {
	case ratio <= 0.85:
		confidence = methods.LocalInferenceRunConfidenceHigh
		summary = "High: estimated memory fits with headroom"
	case ratio <= 1.20:
		confidence = methods.LocalInferenceRunConfidenceMedium
		summary = "Medium: may run, but memory is close to or above the machine limit"
	}

	return methods.LocalInferenceRunEstimate{
		Confidence:           confidence,
		Summary:              summary,
		EstimatedMemoryBytes: estimatedBytes,
		MachineMemoryBytes:   machine.MemoryBytes,
		WeightBytes:          weightBytes,
		KVCacheBytes:         kvBytes,
		OverheadBytes:        overheadBytes,
		Details:              details,
	}
}

func estimateWeightBytes(model methods.LocalInferenceModel, download *methods.LocalInferenceDownloadState) (int64, string) {
	var candidates []int64
	if download != nil && download.BytesTotal > 0 {
		candidates = append(candidates, download.BytesTotal)
	}
	if model.InstalledBytes > 0 {
		candidates = append(candidates, model.InstalledBytes)
	}
	if model.DownloadBytes > 0 {
		candidates = append(candidates, model.DownloadBytes)
	}
	if parameterBytes := estimateWeightBytesFromParameters(model.ParameterSize, model.Quantization); parameterBytes > 0 {
		candidates = append(candidates, parameterBytes)
	}
	var weightBytes int64
	for _, candidate := range candidates {
		if candidate > weightBytes {
			weightBytes = candidate
		}
	}
	if weightBytes <= 0 {
		return 0, "Weights: unknown; no disk, download, or parameter metadata available."
	}
	return weightBytes, fmt.Sprintf("Weights: %s estimated from model size metadata.", formatBytesIEC(weightBytes))
}

func estimateWeightBytesFromParameters(parameterSize, quantization string) int64 {
	params := estimateParameterCount(parameterSize)
	if params <= 0 {
		return 0
	}
	return int64(params * bytesPerParameter(quantization))
}

func estimateParameterCount(parameterSize string) float64 {
	match := parameterSizePattern.FindStringSubmatch(parameterSize)
	if len(match) != 3 {
		return 0
	}
	value, err := strconv.ParseFloat(match[1], 64)
	if err != nil || value <= 0 {
		return 0
	}
	switch strings.ToLower(match[2]) {
	case "b":
		return value * 1_000_000_000
	case "m":
		return value * 1_000_000
	default:
		return 0
	}
}

func bytesPerParameter(quantization string) float64 {
	quantization = strings.ToLower(quantization)
	switch {
	case strings.Contains(quantization, "mxfp4"), strings.Contains(quantization, "nvfp4"), strings.Contains(quantization, "4-bit"), strings.Contains(quantization, "4bit"):
		return 0.60
	case strings.Contains(quantization, "8-bit"), strings.Contains(quantization, "8bit"):
		return 1.00
	case strings.Contains(quantization, "fp16"), strings.Contains(quantization, "f16"), strings.Contains(quantization, "bf16"):
		return 2.00
	default:
		return 1.0
	}
}

func estimateKVCacheBytes(parameterCount float64, contextWindow int) int64 {
	if parameterCount <= 0 || contextWindow <= 0 {
		return 0
	}
	activeContext := math.Min(float64(contextWindow), 32768)
	parameterBillions := parameterCount / 1_000_000_000
	kvAt32KFor7B := float64(4 * 1024 * 1024 * 1024)
	return int64(kvAt32KFor7B * math.Sqrt(parameterBillions/7.0) * (activeContext / 32768.0))
}

func formatBytesIEC(value int64) string {
	if value <= 0 {
		return "unknown"
	}
	units := []string{"B", "KB", "MB", "GB", "TB"}
	next := float64(value)
	unit := 0
	for next >= 1024 && unit < len(units)-1 {
		next /= 1024
		unit++
	}
	if next >= 10 || unit == 0 {
		return strconv.FormatFloat(next, 'f', 0, 64) + " " + units[unit]
	}
	return strconv.FormatFloat(next, 'f', 1, 64) + " " + units[unit]
}
