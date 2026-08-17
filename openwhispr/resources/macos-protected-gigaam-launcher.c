// Launcher for the protected GigaAM helper (macOS, Developer ID builds).
//
// The real helper needs Secure Enclave access, which means the
// `keychain-access-groups` + `com.apple.application-identifier` entitlements.
// AMFI only honours those when a provisioning profile authorizes them, and a
// profile can only be embedded in a BUNDLE (Contents/embedded.provisionprofile)
// — a bare Mach-O in Resources/bin has nowhere to carry one. So the signed
// release ships the helper inside its own nested app bundle:
//
//   Resources/bin/type-protected-gigaam                    <- this launcher
//   Resources/bin/macos-gigaam-encoder                     <- ANE encoder helper
//   Resources/bin/TypeProtectedGigaAM.app/Contents/MacOS/type-protected-gigaam
//
// Node spawns `Resources/bin/type-protected-gigaam` (unchanged path contract),
// this launcher execs the real helper inside the bundle. exec — not fork — so
// the sidecar keeps the same pid and its stdio pipes, which the stdio protocol
// in protectedGigaamSidecar.js depends on.
//
// The helper resolves the ANE encoder next to its own executable, which inside
// the nested bundle no longer holds it, so the path is passed explicitly via
// TYPE_ANE_ENCODER_PATH (the same override the sidecar honours in development).

#include <errno.h>
#include <libgen.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define NESTED_REL "TypeProtectedGigaAM.app/Contents/MacOS/type-protected-gigaam"
#define ENCODER_REL "macos-gigaam-encoder"

int main(int argc, char **argv) {
  (void)argc; // argv is forwarded wholesale to the real helper.
  char exe[PATH_MAX];
  uint32_t size = sizeof(exe);
  if (_NSGetExecutablePath(exe, &size) != 0) {
    fprintf(stderr, "type-protected-gigaam launcher: executable path too long\n");
    return 71;
  }
  // dirname() may write to its argument, so hand it a copy.
  char exe_copy[PATH_MAX];
  snprintf(exe_copy, sizeof(exe_copy), "%s", exe);
  const char *bin_dir = dirname(exe_copy);

  char encoder[PATH_MAX];
  snprintf(encoder, sizeof(encoder), "%s/%s", bin_dir, ENCODER_REL);
  // Only set it when we actually shipped the encoder, and never clobber an
  // explicit override from the environment (development uses that path).
  if (getenv("TYPE_ANE_ENCODER_PATH") == NULL && access(encoder, X_OK) == 0) {
    setenv("TYPE_ANE_ENCODER_PATH", encoder, 1);
  }

  char target[PATH_MAX];
  snprintf(target, sizeof(target), "%s/%s", bin_dir, NESTED_REL);

  execv(target, argv);

  // execv only returns on failure — fail closed and loudly, because silently
  // continuing would look to the app like a helper that produced no output.
  fprintf(stderr, "type-protected-gigaam launcher: cannot exec %s: %s\n", target,
          strerror(errno));
  return 72;
}
