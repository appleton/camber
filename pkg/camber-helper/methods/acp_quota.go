package methods

import "time"

const ACPReadQuotaMethod = acpMethodPrefix + "quota/read"

type ACPQuotaBucket struct {
	Label       string     `json:"label"`
	UsedPercent float64    `json:"usedPercent"`
	ResetsAt    *time.Time `json:"resetsAt,omitempty"`
}

type ACPReadQuotaOutput struct {
	Buckets []ACPQuotaBucket `json:"buckets"`
}
