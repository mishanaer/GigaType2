export const GIGATYPE_ONBOARDING_COMPLETED_KEY = "gigatypeOnboardingCompleted.v1";
export const LEGACY_ONBOARDING_COMPLETED_KEY = "onboardingCompleted";
export const ONBOARDING_CURRENT_STEP_KEY = "onboardingCurrentStep";

export function isGigaTypeOnboardingCompleted() {
  return localStorage.getItem(GIGATYPE_ONBOARDING_COMPLETED_KEY) === "true";
}

export function markGigaTypeOnboardingCompleted() {
  localStorage.setItem(GIGATYPE_ONBOARDING_COMPLETED_KEY, "true");
  localStorage.setItem(LEGACY_ONBOARDING_COMPLETED_KEY, "true");
}

export function resetOnboardingToPermissionsStep() {
  localStorage.setItem(ONBOARDING_CURRENT_STEP_KEY, "0");
}
