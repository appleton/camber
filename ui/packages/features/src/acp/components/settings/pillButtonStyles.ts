// Pill buttons matching the agent cards' header actions. Shared across the
// settings sections that render those cards (voice models, ACP agents) so the
// recipe stays in one place.
export const pillButtonBase =
  "outline-hidden focus-visible:outline-psx-focus flex shrink-0 items-center justify-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors duration-200 ease-out focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50";
export const primaryPillButtonClass = `${pillButtonBase} bg-psx-button-primary-background text-psx-button-primary-foreground hover:bg-psx-button-primary-hover-background`;
export const secondaryPillButtonClass = `${pillButtonBase} border-psx-button-secondary-border bg-psx-button-secondary-background text-psx-button-secondary-foreground hover:bg-psx-button-secondary-hover-background border`;
export const dangerPillButtonClass = `${pillButtonBase} border-psx-error-foreground/40 text-psx-error-foreground hover:bg-psx-error-foreground/10 border`;
// Vibrant variant for the "update available" affordance, distinct from the
// default primary pill color.
export const updatePillButtonClass = `${pillButtonBase} bg-psx-vibrant text-white hover:bg-psx-vibrant/85`;
