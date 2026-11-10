package handler

import (
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// setupVoiceInput registers the local Whisper speech-to-text methods. getState
// and transcribe are also callable by remote (mobile) clients — see the
// remote surface — so a phone can record audio and have the desktop
// machine transcribe it locally.
func setupVoiceInput(h *CamberHandler) {
	registerExtensionMethod(h, JSONRPCOperation{
		Method:      methods.VoiceInputGetStateMethod,
		Description: "returns local Whisper voice input state and model catalog",
	}, h.voiceInputHandler.GetState)

	registerExtensionMethod(h, JSONRPCOperation{
		Method:      methods.VoiceInputSetModelMethod,
		Description: "selects the local Whisper model used for transcription",
	}, h.voiceInputHandler.SetModel)

	registerExtensionMethod(h, JSONRPCOperation{
		Method:      methods.VoiceInputDownloadModelMethod,
		Description: "starts downloading a local Whisper model",
	}, h.voiceInputHandler.DownloadModel)

	registerExtensionMethod(h, JSONRPCOperation{
		Method:      methods.VoiceInputCancelDownloadMethod,
		Description: "cancels a local Whisper model download",
	}, h.voiceInputHandler.CancelDownload)

	registerExtensionMethod(h, JSONRPCOperation{
		Method:      methods.VoiceInputDeleteModelMethod,
		Description: "deletes a local Whisper model from disk",
	}, h.voiceInputHandler.DeleteModel)

	// Transcription may need to cold-start whisper-server and load the model,
	// which can exceed the default request deadline.
	registerExtensionMethodNoDeadline(h, JSONRPCOperation{
		Method:      methods.VoiceInputTranscribeMethod,
		Description: "transcribes base64 WAV audio with the local Whisper model",
	}, h.voiceInputHandler.Transcribe)

}
