/**
 * The complete public surface of hypium 6.1.0.210's OHOS driver: 106 methods
 * on `OHOSDriver` plus 12 compatibility members. Every entry maps to exactly
 * one member of `HypiumDriver`; the unit test enforces both the count and the
 * mapping, so this table cannot drift from the facade.
 *
 * `status` is what the SDK can honestly claim today:
 * - verified   — exercised on a real device (BRA-AL00, uitest 7.0.0.1)
 * - device     — implemented; no acceptance run has exercised it yet
 * - host       — runs on the host or is an alias, no device call of its own
 * - hardware   — needs a pen / watch crown / touchpad; errors clearly without it
 * - unsupported— the device extension cannot serve it (measured)
 */
export type HypiumStatus = "verified" | "device" | "host" | "hardware" | "unsupported";

export type HypiumCategory =
  | "display"
  | "tap"
  | "gesture"
  | "multi"
  | "mouse"
  | "pen"
  | "keyboard"
  | "keys"
  | "component"
  | "window"
  | "screen"
  | "image"
  | "events"
  | "app"
  | "file"
  | "wait"
  | "ime"
  | "hardware"
  | "device";

export interface HypiumCatalogEntry {
  python: string;
  ts: string;
  category: HypiumCategory;
  status: HypiumStatus;
  note?: string;
}

export const HYPIIUM_CATALOG: readonly HypiumCatalogEntry[] = [
  // display / power / lock
  { python: "close_display", ts: "closeDisplay", category: "display", status: "verified" },
  { python: "unlock", ts: "unlock", category: "display", status: "verified", note: "swipe unlock; a PIN still needs a person" },
  { python: "set_sleep_time", ts: "setSleepTime", category: "display", status: "verified" },
  { python: "restore_sleep_time", ts: "restoreSleepTime", category: "display", status: "verified" },
  { python: "is_display_on", ts: "isDisplayOn", category: "display", status: "verified" },
  { python: "is_display_locked", ts: "isDisplayLocked", category: "display", status: "verified" },
  { python: "wake_up_display", ts: "wakeUpDisplay", category: "display", status: "verified" },
  { python: "get_display_rotation", ts: "getDisplayRotation", category: "display", status: "verified" },
  { python: "set_display_rotation", ts: "setDisplayRotation", category: "display", status: "verified", note: "call succeeds; this phone keeps its orientation because auto-rotate is off" },
  { python: "set_display_rotation_enabled", ts: "setDisplayRotationEnabled", category: "display", status: "verified" },

  // tap / long press
  { python: "click", ts: "click", category: "tap", status: "verified" },
  { python: "double_click", ts: "doubleClick", category: "tap", status: "verified" },
  { python: "long_click", ts: "longClick", category: "tap", status: "verified" },
  { python: "touch", ts: "touch", category: "tap", status: "verified" },

  // swipes and paths
  { python: "drag", ts: "drag", category: "gesture", status: "verified" },
  { python: "slide", ts: "slide", category: "gesture", status: "verified" },
  { python: "swipe", ts: "swipe", category: "gesture", status: "verified" },
  { python: "fling", ts: "fling", category: "gesture", status: "verified" },
  { python: "swipe_to_home", ts: "swipeToHome", category: "gesture", status: "verified" },
  { python: "swipe_to_back", ts: "swipeToBack", category: "gesture", status: "verified" },
  { python: "swipe_to_recent_task", ts: "swipeToRecentTask", category: "gesture", status: "verified" },
  { python: "pinch_in", ts: "pinchIn", category: "gesture", status: "verified" },
  { python: "pinch_out", ts: "pinchOut", category: "gesture", status: "verified" },
  { python: "inject_gesture", ts: "injectGesture", category: "gesture", status: "verified" },

  // multiple fingers
  { python: "inject_multi_finger_gesture", ts: "injectMultiFingerGesture", category: "multi", status: "verified" },
  { python: "two_finger_swipe", ts: "twoFingerSwipe", category: "multi", status: "verified" },
  { python: "multi_finger_touch", ts: "multiFingerTouch", category: "multi", status: "verified" },

  // mouse
  { python: "mouse_double_click", ts: "mouseDoubleClick", category: "mouse", status: "verified" },
  { python: "mouse_long_click", ts: "mouseLongClick", category: "mouse", status: "verified" },
  { python: "mouse_click", ts: "mouseClick", category: "mouse", status: "verified" },
  { python: "mouse_scroll", ts: "mouseScroll", category: "mouse", status: "verified" },
  { python: "mouse_move_to", ts: "mouseMoveTo", category: "mouse", status: "verified" },
  { python: "mouse_move", ts: "mouseMove", category: "mouse", status: "verified" },
  { python: "mouse_drag", ts: "mouseDrag", category: "mouse", status: "verified" },

  // pen
  { python: "pen_click", ts: "penClick", category: "pen", status: "verified" },
  { python: "pen_double_click", ts: "penDoubleClick", category: "pen", status: "verified" },
  { python: "pen_long_click", ts: "penLongClick", category: "pen", status: "verified" },
  { python: "pen_swipe", ts: "penSwipe", category: "pen", status: "verified" },
  { python: "pen_slide", ts: "penSlide", category: "pen", status: "verified" },
  { python: "pen_drag", ts: "penDrag", category: "pen", status: "verified" },
  { python: "pen_inject_gesture", ts: "penInjectGesture", category: "pen", status: "verified" },

  // keyboard and text
  { python: "input_text", ts: "inputText", category: "keyboard", status: "verified" },
  { python: "clear_text", ts: "clearText", category: "keyboard", status: "verified" },
  { python: "move_cursor", ts: "moveCursor", category: "keyboard", status: "verified" },
  { python: "press_key", ts: "pressKey", category: "keyboard", status: "verified" },
  { python: "press_combination_key", ts: "pressCombinationKey", category: "keyboard", status: "verified" },

  // system keys
  { python: "press_home", ts: "pressHome", category: "keys", status: "verified" },
  { python: "go_home", ts: "goHome", category: "keys", status: "verified" },
  { python: "go_back", ts: "goBack", category: "keys", status: "verified" },
  { python: "press_back", ts: "pressBack", category: "keys", status: "verified" },
  { python: "press_power", ts: "pressPower", category: "keys", status: "verified" },
  { python: "take_screenshot", ts: "takeScreenshot", category: "keys", status: "device", note: "sends volume_down+power; the file lands in the media library, which shell cannot read" },

  // components
  { python: "get_component_pos", ts: "getComponentPos", category: "component", status: "verified" },
  { python: "get_component_bound", ts: "getComponentBound", category: "component", status: "verified" },
  { python: "get_component_property", ts: "getComponentProperty", category: "component", status: "verified" },
  { python: "find_component", ts: "findComponent", category: "component", status: "verified" },
  { python: "find_all_components", ts: "findAllComponents", category: "component", status: "verified" },
  { python: "switch_component_status", ts: "switchComponentStatus", category: "component", status: "verified" },
  { python: "check_exist", ts: "checkExist", category: "component", status: "verified" },
  { python: "check_component_exist", ts: "checkComponentExist", category: "component", status: "verified" },
  { python: "check_component", ts: "checkComponent", category: "component", status: "verified" },
  { python: "wait_for_component", ts: "waitForComponent", category: "component", status: "verified" },
  { python: "wait_for_component_disappear", ts: "waitForComponentDisappear", category: "component", status: "verified" },

  // windows
  { python: "find_window", ts: "findWindow", category: "window", status: "verified" },
  { python: "get_window_size", ts: "getWindowSize", category: "window", status: "verified" },
  { python: "get_current_window", ts: "getCurrentWindow", category: "window", status: "verified" },
  { python: "check_current_window", ts: "checkCurrentWindow", category: "window", status: "verified" },
  { python: "check_window", ts: "checkWindow", category: "window", status: "verified" },
  { python: "check_window_exist", ts: "checkWindowExist", category: "window", status: "verified" },

  // screen and coordinates
  { python: "get_display_size", ts: "getDisplaySize", category: "screen", status: "verified" },
  { python: "capture_screen", ts: "captureScreen", category: "screen", status: "verified" },
  { python: "to_absolute_position", ts: "toAbsolutePosition", category: "screen", status: "verified" },
  { python: "to_abs_pos", ts: "toAbsPos", category: "screen", status: "verified" },

  // image matching (host-side)
  { python: "find_image", ts: "findImage", category: "image", status: "verified", note: "template mode; SIFT needs OpenCV" },
  { python: "touch_image", ts: "touchImage", category: "image", status: "verified", note: "template mode; SIFT needs OpenCV" },
  { python: "check_image_exist", ts: "checkImageExist", category: "image", status: "verified", note: "template mode; SIFT needs OpenCV" },

  // toast / UI events
  { python: "start_listen_toast", ts: "startListenToast", category: "events", status: "unsupported", note: "UIEventObserver never replies over the raw RPC socket" },
  { python: "get_latest_toast", ts: "getLatestToast", category: "events", status: "unsupported", note: "UIEventObserver never replies over the raw RPC socket" },
  { python: "check_toast", ts: "checkToast", category: "events", status: "unsupported", note: "UIEventObserver never replies over the raw RPC socket" },
  { python: "start_listen_ui_event", ts: "startListenUiEvent", category: "events", status: "unsupported", note: "UIEventObserver never replies over the raw RPC socket" },
  { python: "get_latest_ui_event", ts: "getLatestUiEvent", category: "events", status: "unsupported", note: "UIEventObserver never replies over the raw RPC socket" },

  // app management
  { python: "start_app", ts: "startApp", category: "app", status: "verified" },
  { python: "stop_app", ts: "stopApp", category: "app", status: "verified" },
  { python: "has_app", ts: "hasApp", category: "app", status: "verified" },
  { python: "current_app", ts: "currentApp", category: "app", status: "verified" },
  { python: "install_app", ts: "installApp", category: "app", status: "device", note: "a bad path is reported; no successful install was run" },
  { python: "uninstall_app", ts: "uninstallApp", category: "app", status: "device", note: "a missing bundle is reported; no successful uninstall was run" },
  { python: "clear_app_data", ts: "clearAppData", category: "app", status: "device", note: "destructive; not exercised on a real bundle" },

  // hdc and files
  { python: "hdc", ts: "hdc", category: "file", status: "verified" },
  { python: "shell", ts: "shell", category: "file", status: "verified" },
  { python: "pull_file", ts: "pullFile", category: "file", status: "verified" },
  { python: "push_file", ts: "pushFile", category: "file", status: "verified" },
  { python: "has_file", ts: "hasFile", category: "file", status: "verified" },

  // waits
  { python: "wait", ts: "wait", category: "wait", status: "verified" },
  { python: "wait_for_idle", ts: "waitForIdle", category: "wait", status: "verified" },
  { python: "set_implicit_wait_time", ts: "setImplicitWaitTime", category: "wait", status: "verified" },
  { python: "get_implicit_wait_time", ts: "getImplicitWaitTime", category: "wait", status: "verified" },

  // IME
  { python: "input_text_on_current_cursor", ts: "inputTextOnCurrentCursor", category: "ime", status: "verified" },

  // special hardware
  { python: "touchpad_swipe", ts: "touchpadSwipe", category: "hardware", status: "hardware", note: "2-in-1 touchpad" },
  { python: "touchpad_swipe_and_hold", ts: "touchpadSwipeAndHold", category: "hardware", status: "hardware", note: "2-in-1 touchpad" },
  { python: "rotate_crown", ts: "rotateCrown", category: "hardware", status: "hardware", note: "wearable crown" },

  // device info, logging and hooks
  { python: "log_debug", ts: "logDebug", category: "device", status: "verified" },
  { python: "log_info", ts: "logInfo", category: "device", status: "verified" },
  { python: "log_warning", ts: "logWarning", category: "device", status: "verified" },
  { python: "log_error", ts: "logError", category: "device", status: "verified" },
  { python: "execute_shell_command", ts: "executeShellCommand", category: "device", status: "verified" },
  { python: "execute_connector_command", ts: "executeConnectorCommand", category: "device", status: "verified" },
  { python: "device_type", ts: "deviceType", category: "device", status: "verified" },
  { python: "sn", ts: "sn", category: "device", status: "verified", note: "returns the hashed device tag, never the raw serial" },
  { python: "os_type", ts: "osType", category: "device", status: "verified" },
  { python: "ScreenLock", ts: "screenLock", category: "device", status: "verified" },
  { python: "log", ts: "log", category: "device", status: "verified" },
  { python: "get_device_type", ts: "getDeviceType", category: "device", status: "verified" },
  { python: "get_os_type", ts: "getOsType", category: "device", status: "verified" },
  { python: "close", ts: "close", category: "device", status: "verified" },
  { python: "add_hook", ts: "addHook", category: "device", status: "verified" },
  { python: "remove_hook", ts: "removeHook", category: "device", status: "verified" },
  { python: "remove_all_hooks", ts: "removeAllHooks", category: "device", status: "verified" },
];
