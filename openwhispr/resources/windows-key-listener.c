/**
 * Windows Key Listener for Push-to-Talk
 *
 * Uses Windows Low-Level Keyboard Hook to detect key up/down events.
 * Accepts a virtual key code as command line argument.
 * Outputs "KEY_DOWN" and "KEY_UP" to stdout.
 *
 * Compile with: cl /O2 windows-key-listener.c /Fe:windows-key-listener.exe user32.lib
 * Or with MinGW: gcc -O2 windows-key-listener.c -o windows-key-listener.exe -luser32
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static HHOOK g_hook = NULL;
static DWORD g_targetVk = 0;
static BOOL g_isKeyDown = FALSE;
static BOOL g_captureMode = FALSE;
static BOOL g_captureCompleted = FALSE;
static BOOL g_captureHadBaseKey = FALSE;
static BOOL g_capsLockDown = FALSE;
static BOOL g_suppressRequiredModifiersUntilReleased = FALSE;
static unsigned int g_captureModifierMask = 0;
static DWORD g_captureLastModifierVk = 0;

// Modifier key requirements
static BOOL g_requireCtrl = FALSE;
static BOOL g_requireAlt = FALSE;
static BOOL g_requireShift = FALSE;
static BOOL g_requireWin = FALSE;
static BOOL g_requireCapsLock = FALSE;
static BOOL g_useModifiersOnly = FALSE;
static BOOL g_ctrlDown = FALSE;
static BOOL g_altDown = FALSE;
static BOOL g_shiftDown = FALSE;
static BOOL g_leftWinDown = FALSE;
static BOOL g_rightWinDown = FALSE;
static BOOL g_hasUnsupportedFnToken = FALSE;

#define CAPTURE_CTRL  0x01
#define CAPTURE_WIN   0x02
#define CAPTURE_ALT   0x04
#define CAPTURE_SHIFT 0x08

static BOOL IsCtrlVk(DWORD vkCode) {
    return vkCode == VK_CONTROL || vkCode == VK_LCONTROL || vkCode == VK_RCONTROL;
}

static BOOL IsAltVk(DWORD vkCode) {
    return vkCode == VK_MENU || vkCode == VK_LMENU || vkCode == VK_RMENU;
}

static BOOL IsShiftVk(DWORD vkCode) {
    return vkCode == VK_SHIFT || vkCode == VK_LSHIFT || vkCode == VK_RSHIFT;
}

static BOOL IsWinVk(DWORD vkCode) {
    return vkCode == VK_LWIN || vkCode == VK_RWIN;
}

static BOOL IsRightModifierVk(DWORD vkCode) {
    return vkCode == VK_RCONTROL || vkCode == VK_RMENU ||
           vkCode == VK_RSHIFT || vkCode == VK_RWIN;
}

static unsigned int ModifierMaskForVk(DWORD vkCode) {
    if (IsCtrlVk(vkCode)) return CAPTURE_CTRL;
    if (IsWinVk(vkCode)) return CAPTURE_WIN;
    if (IsAltVk(vkCode)) return CAPTURE_ALT;
    if (IsShiftVk(vkCode)) return CAPTURE_SHIFT;
    return 0;
}

static void UpdateModifierState(DWORD vkCode, BOOL isKeyDown) {
    if (IsCtrlVk(vkCode)) {
        g_ctrlDown = isKeyDown;
        return;
    }

    if (IsAltVk(vkCode)) {
        g_altDown = isKeyDown;
        return;
    }

    if (IsShiftVk(vkCode)) {
        g_shiftDown = isKeyDown;
        return;
    }

    if (vkCode == VK_LWIN) {
        g_leftWinDown = isKeyDown;
        return;
    }

    if (vkCode == VK_RWIN) {
        g_rightWinDown = isKeyDown;
        return;
    }

    if (vkCode == VK_CAPITAL) {
        g_capsLockDown = isKeyDown;
    }
}

static BOOL IsRequiredModifierEvent(DWORD vkCode) {
    return (g_requireCtrl && IsCtrlVk(vkCode)) ||
           (g_requireAlt && IsAltVk(vkCode)) ||
           (g_requireShift && IsShiftVk(vkCode)) ||
           (g_requireWin && IsWinVk(vkCode)) ||
           (g_requireCapsLock && vkCode == VK_CAPITAL);
}

// Sync tracked modifier state with actual key state for keys that are NOT
// the current hook event. GetAsyncKeyState() is unreliable for the key that
// triggered the current hook callback, but accurate for all other keys.
// This corrects stale state caused by missed key-up events (e.g. Win+L lock).
static void SyncModifierState(DWORD currentVkCode) {
    if (!IsCtrlVk(currentVkCode))
        g_ctrlDown = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
    if (!IsAltVk(currentVkCode))
        g_altDown = (GetAsyncKeyState(VK_MENU) & 0x8000) != 0;
    if (!IsShiftVk(currentVkCode))
        g_shiftDown = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
    if (currentVkCode != VK_LWIN)
        g_leftWinDown = (GetAsyncKeyState(VK_LWIN) & 0x8000) != 0;
    if (currentVkCode != VK_RWIN)
        g_rightWinDown = (GetAsyncKeyState(VK_RWIN) & 0x8000) != 0;
    if (currentVkCode != VK_CAPITAL)
        g_capsLockDown = (GetAsyncKeyState(VK_CAPITAL) & 0x8000) != 0;
}

static BOOL AreRequiredModifiersPressed(void) {
    if (g_requireCtrl && !g_ctrlDown) return FALSE;
    if (g_requireAlt && !g_altDown) return FALSE;
    if (g_requireShift && !g_shiftDown) return FALSE;
    if (g_requireWin && !(g_leftWinDown || g_rightWinDown)) return FALSE;
    if (g_requireCapsLock && !g_capsLockDown) return FALSE;
    return TRUE;
}

static const char* CaptureKeyName(DWORD vkCode) {
    static char name[16];

    if (vkCode >= 'A' && vkCode <= 'Z') {
        name[0] = (char)vkCode;
        name[1] = '\0';
        return name;
    }
    if (vkCode >= '0' && vkCode <= '9') {
        name[0] = (char)vkCode;
        name[1] = '\0';
        return name;
    }
    if (vkCode >= VK_F1 && vkCode <= VK_F24) {
        snprintf(name, sizeof(name), "F%lu", (unsigned long)(vkCode - VK_F1 + 1));
        return name;
    }

    switch (vkCode) {
        case VK_SPACE: return "Space";
        case VK_TAB: return "Tab";
        case VK_RETURN: return "Enter";
        case VK_BACK: return "Backspace";
        case VK_INSERT: return "Insert";
        case VK_DELETE: return "Delete";
        case VK_HOME: return "Home";
        case VK_END: return "End";
        case VK_PRIOR: return "PageUp";
        case VK_NEXT: return "PageDown";
        case VK_UP: return "Up";
        case VK_DOWN: return "Down";
        case VK_LEFT: return "Left";
        case VK_RIGHT: return "Right";
        case VK_PAUSE: return "Pause";
        case VK_SCROLL: return "ScrollLock";
        case VK_SNAPSHOT: return "PrintScreen";
        case VK_NUMLOCK: return "NumLock";
        case VK_OEM_3: return "`";
        case VK_OEM_MINUS: return "-";
        case VK_OEM_PLUS: return "=";
        case VK_OEM_4: return "[";
        case VK_OEM_6: return "]";
        case VK_OEM_5: return "\\";
        case VK_OEM_1: return ";";
        case VK_OEM_7: return "'";
        case VK_OEM_COMMA: return ",";
        case VK_OEM_PERIOD: return ".";
        case VK_OEM_2: return "/";
        case VK_NUMPAD0: return "num0";
        case VK_NUMPAD1: return "num1";
        case VK_NUMPAD2: return "num2";
        case VK_NUMPAD3: return "num3";
        case VK_NUMPAD4: return "num4";
        case VK_NUMPAD5: return "num5";
        case VK_NUMPAD6: return "num6";
        case VK_NUMPAD7: return "num7";
        case VK_NUMPAD8: return "num8";
        case VK_NUMPAD9: return "num9";
        case VK_ADD: return "numadd";
        case VK_SUBTRACT: return "numsub";
        case VK_MULTIPLY: return "nummult";
        case VK_DIVIDE: return "numdiv";
        case VK_DECIMAL: return "numdec";
        default: return NULL;
    }
}

static void AppendCapturePart(char* buffer, size_t size, const char* part) {
    if (!part || !*part) return;
    if (buffer[0] != '\0') strncat(buffer, "+", size - strlen(buffer) - 1);
    strncat(buffer, part, size - strlen(buffer) - 1);
}

static void EmitCapturedHotkey(const char* baseKey, BOOL includeCapsLock) {
    char hotkey[256] = "";
    if (g_ctrlDown) AppendCapturePart(hotkey, sizeof(hotkey), "Control");
    if (g_leftWinDown || g_rightWinDown)
        AppendCapturePart(hotkey, sizeof(hotkey), "Super");
    if (g_altDown) AppendCapturePart(hotkey, sizeof(hotkey), "Alt");
    if (g_shiftDown) AppendCapturePart(hotkey, sizeof(hotkey), "Shift");
    if (includeCapsLock) AppendCapturePart(hotkey, sizeof(hotkey), "CapsLock");
    AppendCapturePart(hotkey, sizeof(hotkey), baseKey);

    if (hotkey[0] != '\0') {
        printf("CAPTURE %s\n", hotkey);
        fflush(stdout);
        g_captureCompleted = TRUE;
    }
}

static void EmitCapturedModifierOnly(void) {
    char hotkey[128] = "";
    unsigned int mask = g_captureModifierMask;
    int count = ((mask & CAPTURE_CTRL) != 0) + ((mask & CAPTURE_WIN) != 0) +
                ((mask & CAPTURE_ALT) != 0) + ((mask & CAPTURE_SHIFT) != 0);

    if (count == 1 && IsRightModifierVk(g_captureLastModifierVk)) {
        if (g_captureLastModifierVk == VK_RCONTROL) strcpy(hotkey, "RightControl");
        else if (g_captureLastModifierVk == VK_RMENU) strcpy(hotkey, "RightAlt");
        else if (g_captureLastModifierVk == VK_RSHIFT) strcpy(hotkey, "RightShift");
        else if (g_captureLastModifierVk == VK_RWIN) strcpy(hotkey, "RightSuper");
    } else if (count >= 2) {
        if (mask & CAPTURE_CTRL) AppendCapturePart(hotkey, sizeof(hotkey), "Control");
        if (mask & CAPTURE_WIN) AppendCapturePart(hotkey, sizeof(hotkey), "Super");
        if (mask & CAPTURE_ALT) AppendCapturePart(hotkey, sizeof(hotkey), "Alt");
        if (mask & CAPTURE_SHIFT) AppendCapturePart(hotkey, sizeof(hotkey), "Shift");
    }

    if (hotkey[0] != '\0') {
        printf("CAPTURE %s\n", hotkey);
        fflush(stdout);
        g_captureCompleted = TRUE;
    }
}

static LRESULT HandleCaptureEvent(WPARAM wParam, KBDLLHOOKSTRUCT* kbd) {
    BOOL isKeyDown = (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN);
    BOOL isKeyUp = (wParam == WM_KEYUP || wParam == WM_SYSKEYUP);
    BOOL isModifier = IsCtrlVk(kbd->vkCode) || IsAltVk(kbd->vkCode) ||
                      IsShiftVk(kbd->vkCode) || IsWinVk(kbd->vkCode);

    if (!isKeyDown && !isKeyUp) return 1;
    if (g_captureCompleted) return 1;

    if (isModifier) {
        if (isKeyDown) {
            UpdateModifierState(kbd->vkCode, TRUE);
            g_captureModifierMask |= ModifierMaskForVk(kbd->vkCode);
            g_captureLastModifierVk = kbd->vkCode;
        } else {
            UpdateModifierState(kbd->vkCode, FALSE);
            if (!g_ctrlDown && !g_altDown && !g_shiftDown &&
                !g_leftWinDown && !g_rightWinDown && !g_captureHadBaseKey) {
                EmitCapturedModifierOnly();
                if (!g_captureCompleted) {
                    g_captureModifierMask = 0;
                    g_captureLastModifierVk = 0;
                }
            }
        }
        return 1;
    }

    if (kbd->vkCode == VK_ESCAPE && isKeyDown) {
        printf("CAPTURE_CANCEL\n");
        fflush(stdout);
        g_captureCompleted = TRUE;
        return 1;
    }

    if (kbd->vkCode == VK_CAPITAL) {
        if (isKeyDown) {
            g_capsLockDown = TRUE;
        } else {
            g_capsLockDown = FALSE;
            if (!g_captureHadBaseKey) EmitCapturedHotkey("CapsLock", FALSE);
        }
        return 1;
    }

    if (isKeyDown) {
        const char* keyName = CaptureKeyName(kbd->vkCode);
        g_captureHadBaseKey = TRUE;
        if (keyName) EmitCapturedHotkey(keyName, g_capsLockDown);
    }

    // Suppress captured keys so Win+L, Win+letter, CapsLock, etc. do not
    // activate Windows while the settings field is waiting for a shortcut.
    return 1;
}

// Map key name to virtual key code
DWORD ParseKeyCode(const char* keyName) {
    // Function keys (F1-F12)
    if (_stricmp(keyName, "F1") == 0) return VK_F1;
    if (_stricmp(keyName, "F2") == 0) return VK_F2;
    if (_stricmp(keyName, "F3") == 0) return VK_F3;
    if (_stricmp(keyName, "F4") == 0) return VK_F4;
    if (_stricmp(keyName, "F5") == 0) return VK_F5;
    if (_stricmp(keyName, "F6") == 0) return VK_F6;
    if (_stricmp(keyName, "F7") == 0) return VK_F7;
    if (_stricmp(keyName, "F8") == 0) return VK_F8;
    if (_stricmp(keyName, "F9") == 0) return VK_F9;
    if (_stricmp(keyName, "F10") == 0) return VK_F10;
    if (_stricmp(keyName, "F11") == 0) return VK_F11;
    if (_stricmp(keyName, "F12") == 0) return VK_F12;

    // Extended function keys (F13-F24)
    if (_stricmp(keyName, "F13") == 0) return VK_F13;
    if (_stricmp(keyName, "F14") == 0) return VK_F14;
    if (_stricmp(keyName, "F15") == 0) return VK_F15;
    if (_stricmp(keyName, "F16") == 0) return VK_F16;
    if (_stricmp(keyName, "F17") == 0) return VK_F17;
    if (_stricmp(keyName, "F18") == 0) return VK_F18;
    if (_stricmp(keyName, "F19") == 0) return VK_F19;
    if (_stricmp(keyName, "F20") == 0) return VK_F20;
    if (_stricmp(keyName, "F21") == 0) return VK_F21;
    if (_stricmp(keyName, "F22") == 0) return VK_F22;
    if (_stricmp(keyName, "F23") == 0) return VK_F23;
    if (_stricmp(keyName, "F24") == 0) return VK_F24;

    // Special keys
    if (_stricmp(keyName, "Pause") == 0) return VK_PAUSE;
    if (_stricmp(keyName, "ScrollLock") == 0) return VK_SCROLL;
    if (_stricmp(keyName, "Insert") == 0) return VK_INSERT;
    if (_stricmp(keyName, "Home") == 0) return VK_HOME;
    if (_stricmp(keyName, "End") == 0) return VK_END;
    if (_stricmp(keyName, "PageUp") == 0) return VK_PRIOR;
    if (_stricmp(keyName, "PageDown") == 0) return VK_NEXT;
    if (_stricmp(keyName, "Space") == 0) return VK_SPACE;
    if (_stricmp(keyName, "Escape") == 0 || _stricmp(keyName, "Esc") == 0) return VK_ESCAPE;
    if (_stricmp(keyName, "Tab") == 0) return VK_TAB;
    if (_stricmp(keyName, "CapsLock") == 0) return VK_CAPITAL;
    if (_stricmp(keyName, "NumLock") == 0) return VK_NUMLOCK;

    // Right-side modifier keys (used as single-key hotkeys)
    if (_stricmp(keyName, "RightAlt") == 0 || _stricmp(keyName, "RightOption") == 0) return VK_RMENU;
    if (_stricmp(keyName, "RightControl") == 0 || _stricmp(keyName, "RightCtrl") == 0) return VK_RCONTROL;
    if (_stricmp(keyName, "RightShift") == 0) return VK_RSHIFT;
    if (_stricmp(keyName, "RightSuper") == 0 || _stricmp(keyName, "RightWin") == 0 ||
        _stricmp(keyName, "RightMeta") == 0 || _stricmp(keyName, "RightCommand") == 0 ||
        _stricmp(keyName, "RightCmd") == 0) return VK_RWIN;

    // Backtick/tilde - the default hotkey
    if (strcmp(keyName, "`") == 0 || _stricmp(keyName, "Backquote") == 0) return VK_OEM_3;

    // Other punctuation
    if (strcmp(keyName, "-") == 0 || _stricmp(keyName, "Minus") == 0) return VK_OEM_MINUS;
    if (strcmp(keyName, "=") == 0 || _stricmp(keyName, "Equal") == 0) return VK_OEM_PLUS;
    if (strcmp(keyName, "[") == 0) return VK_OEM_4;
    if (strcmp(keyName, "]") == 0) return VK_OEM_6;
    if (strcmp(keyName, "\\") == 0) return VK_OEM_5;
    if (strcmp(keyName, ";") == 0) return VK_OEM_1;
    if (strcmp(keyName, "'") == 0) return VK_OEM_7;
    if (strcmp(keyName, ",") == 0) return VK_OEM_COMMA;
    if (strcmp(keyName, ".") == 0) return VK_OEM_PERIOD;
    if (strcmp(keyName, "/") == 0) return VK_OEM_2;

    // Single letter/number - convert to VK code
    if (strlen(keyName) == 1) {
        char c = keyName[0];
        if (c >= 'a' && c <= 'z') return (DWORD)(c - 'a' + 'A');
        if (c >= 'A' && c <= 'Z') return (DWORD)c;
        if (c >= '0' && c <= '9') return (DWORD)c;
    }

    // Try parsing as hex or decimal number (for direct VK codes)
    if (keyName[0] == '0' && (keyName[1] == 'x' || keyName[1] == 'X')) {
        return (DWORD)strtol(keyName, NULL, 16);
    }

    return (DWORD)atoi(keyName);
}

LRESULT CALLBACK LowLevelKeyboardProc(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode == HC_ACTION) {
        KBDLLHOOKSTRUCT* kbd = (KBDLLHOOKSTRUCT*)lParam;
        if (g_captureMode) {
            return HandleCaptureEvent(wParam, kbd);
        }
        BOOL isKeyDown = (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN);
        BOOL isKeyUp = (wParam == WM_KEYUP || wParam == WM_SYSKEYUP);
        BOOL isModifierEvent = IsCtrlVk(kbd->vkCode) || IsAltVk(kbd->vkCode) ||
                               IsShiftVk(kbd->vkCode) || IsWinVk(kbd->vkCode) ||
                               kbd->vkCode == VK_CAPITAL;
        BOOL suppressEvent = FALSE;

        // Caps Lock is a physical state-changing key. When it is part of the
        // configured hotkey, reserve it from the first down event so the
        // shortcut never toggles the user's typing case.
        if (g_requireCapsLock && kbd->vkCode == VK_CAPITAL) {
            suppressEvent = TRUE;
        }

        if (g_suppressRequiredModifiersUntilReleased &&
            IsRequiredModifierEvent(kbd->vkCode)) {
            suppressEvent = TRUE;
        }

        if ((isKeyDown || isKeyUp) && isModifierEvent) {
            UpdateModifierState(kbd->vkCode, isKeyDown);
            SyncModifierState(kbd->vkCode);
        }

        // Stop an active press as soon as one of its required modifiers is released.
        if (g_isKeyDown && isKeyUp && IsRequiredModifierEvent(kbd->vkCode) &&
            !AreRequiredModifiersPressed()) {
            g_isKeyDown = FALSE;
            printf("KEY_UP\n");
            fflush(stdout);
        }

        // Self-heal a missed target-key KEY_UP. GetAsyncKeyState is only reliable
        // for keys other than the one in the current callback, so verify here.
        if (g_isKeyDown && !g_useModifiersOnly && kbd->vkCode != g_targetVk &&
            !(GetAsyncKeyState(g_targetVk) & 0x8000)) {
            g_isKeyDown = FALSE;
            printf("KEY_UP\n");
            fflush(stdout);
        }

        if (g_useModifiersOnly) {
            if (isKeyDown) {
                if (!g_isKeyDown && AreRequiredModifiersPressed()) {
                    g_isKeyDown = TRUE;
                    printf("KEY_DOWN\n");
                    fflush(stdout);
                }
            } else if (isKeyUp) {
                if (g_isKeyDown && !AreRequiredModifiersPressed()) {
                    g_isKeyDown = FALSE;
                    printf("KEY_UP\n");
                    fflush(stdout);
                }
            }
            return suppressEvent ? 1 : CallNextHookEx(g_hook, nCode, wParam, lParam);
        }

        // Check for the target key
        if (kbd->vkCode == g_targetVk) {
            if (isKeyDown) {
                // Only trigger if modifiers are satisfied and not already down
                if (AreRequiredModifiersPressed()) {
                    suppressEvent = TRUE;
                    if (!g_isKeyDown) {
                        g_isKeyDown = TRUE;
                        g_suppressRequiredModifiersUntilReleased = TRUE;
                        printf("KEY_DOWN\n");
                        fflush(stdout);
                    }
                }
            } else if (isKeyUp) {
                // Target key released
                if (g_isKeyDown) {
                    suppressEvent = TRUE;
                    g_isKeyDown = FALSE;
                    printf("KEY_UP\n");
                    fflush(stdout);
                }
            }
        }

        if (g_suppressRequiredModifiersUntilReleased && !AreRequiredModifiersPressed()) {
            g_suppressRequiredModifiersUntilReleased = FALSE;
        }

        if (suppressEvent) {
            return 1;
        }
    }
    return CallNextHookEx(g_hook, nCode, wParam, lParam);
}

BOOL WINAPI ConsoleHandler(DWORD signal) {
    if (signal == CTRL_C_EVENT || signal == CTRL_BREAK_EVENT || signal == CTRL_CLOSE_EVENT) {
        if (g_hook) {
            UnhookWindowsHookEx(g_hook);
            g_hook = NULL;
        }
        ExitProcess(0);
    }
    return TRUE;
}

// Parse a compound hotkey like "CommandOrControl+Shift+F11"
// Sets g_requireCtrl, g_requireAlt, g_requireShift and returns the main key VK code
DWORD ParseCompoundHotkey(const char* hotkey) {
    char buffer[256];
    strncpy(buffer, hotkey, sizeof(buffer) - 1);
    buffer[sizeof(buffer) - 1] = '\0';

    // Reset modifier requirements
    g_requireCtrl = FALSE;
    g_requireAlt = FALSE;
    g_requireShift = FALSE;
    g_requireWin = FALSE;
    g_requireCapsLock = FALSE;
    g_useModifiersOnly = FALSE;
    g_hasUnsupportedFnToken = FALSE;

    DWORD mainKeyVk = 0;
    char* token = strtok(buffer, "+");

    while (token != NULL) {
        // Trim leading/trailing spaces
        while (*token == ' ') token++;
        char* end = token + strlen(token) - 1;
        while (end > token && *end == ' ') *end-- = '\0';

        // Check for modifiers
        if (_stricmp(token, "CommandOrControl") == 0 ||
            _stricmp(token, "Control") == 0 ||
            _stricmp(token, "Ctrl") == 0 ||
            _stricmp(token, "CmdOrCtrl") == 0) {
            g_requireCtrl = TRUE;
        } else if (_stricmp(token, "Alt") == 0 ||
                   _stricmp(token, "Option") == 0) {
            g_requireAlt = TRUE;
        } else if (_stricmp(token, "Shift") == 0) {
            g_requireShift = TRUE;
        } else if (_stricmp(token, "Super") == 0 ||
                   _stricmp(token, "Meta") == 0 ||
                   _stricmp(token, "Win") == 0 ||
                   _stricmp(token, "Command") == 0 ||
                   _stricmp(token, "Cmd") == 0) {
            // Windows key
            g_requireWin = TRUE;
        } else if (_stricmp(token, "CapsLock") == 0 && strchr(hotkey, '+') != NULL) {
            g_requireCapsLock = TRUE;
        } else if (_stricmp(token, "Fn") == 0 ||
                   _stricmp(token, "Globe") == 0) {
            // Windows has no standard Fn virtual key. Reject the shortcut
            // instead of silently treating Fn+F8 as bare F8.
            g_hasUnsupportedFnToken = TRUE;
        } else {
            // This should be the main key
            mainKeyVk = ParseKeyCode(token);
        }

        token = strtok(NULL, "+");
    }

    return mainKeyVk;
}

int main(int argc, char* argv[]) {
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <key>\n", argv[0]);
        fprintf(stderr, "Examples:\n");
        fprintf(stderr, "  %s `                        (backtick)\n", argv[0]);
        fprintf(stderr, "  %s F8                       (function key F1-F12)\n", argv[0]);
        fprintf(stderr, "  %s F13                      (extended function key F13-F24)\n", argv[0]);
        fprintf(stderr, "  %s CommandOrControl+F11     (with modifier)\n", argv[0]);
        fprintf(stderr, "  %s Ctrl+Shift+Space         (multiple modifiers)\n", argv[0]);
        return 1;
    }

    if (_stricmp(argv[1], "--capture") == 0) {
        g_captureMode = TRUE;
    } else {
        g_targetVk = ParseCompoundHotkey(argv[1]);
    }
    if (g_captureMode) {
        fprintf(stderr, "Capturing one Windows hotkey\n");
    }
    if (g_hasUnsupportedFnToken) {
        fprintf(stderr, "Error: Fn/Globe is not a supported Windows hotkey modifier\n");
        return 1;
    }
    if (!g_captureMode && g_targetVk == 0 &&
        (g_requireCtrl || g_requireAlt || g_requireShift || g_requireWin || g_requireCapsLock)) {
        g_useModifiersOnly = TRUE;
    }

    if (!g_captureMode && g_targetVk == 0 && !g_useModifiersOnly) {
        fprintf(stderr, "Error: Invalid key '%s'\n", argv[1]);
        return 1;
    }

    // Log what we're listening for
    if (!g_captureMode) {
        fprintf(stderr, "Listening for: %s (VK=0x%02lX, Ctrl=%d, Alt=%d, Shift=%d, Win=%d, CapsLock=%d, ModOnly=%d)\n",
                argv[1], g_targetVk, g_requireCtrl, g_requireAlt, g_requireShift, g_requireWin,
                g_requireCapsLock, g_useModifiersOnly);
    }

    // Set up console handler for clean shutdown
    SetConsoleCtrlHandler(ConsoleHandler, TRUE);

    // Install the low-level keyboard hook
    g_hook = SetWindowsHookEx(WH_KEYBOARD_LL, LowLevelKeyboardProc, NULL, 0);
    if (!g_hook) {
        fprintf(stderr, "Error: Failed to install keyboard hook (error %lu)\n", GetLastError());
        return 1;
    }

    // Signal that we're ready
    printf("READY\n");
    fflush(stdout);

    // Message loop - required for low-level hooks to work
    MSG msg;
    while (GetMessage(&msg, NULL, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }

    UnhookWindowsHookEx(g_hook);
    return 0;
}
