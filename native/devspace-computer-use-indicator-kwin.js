const PREFIX = "DevSpace Computer Use Indicator";
const RESOURCE_CLASS = "devspace-computer-use-indicator";

function protect(window) {
    if (!window) return;
    const caption = window.caption ? window.caption.toString() : "";
    const resourceClass = window.resourceClass ? window.resourceClass.toString() : "";
    const resourceName = window.resourceName ? window.resourceName.toString() : "";
    if (!caption.startsWith(PREFIX) && resourceClass !== RESOURCE_CLASS && resourceName !== RESOURCE_CLASS) {
        return;
    }
    window.excludeFromCapture = true;
    window.skipTaskbar = true;
    window.skipPager = true;
    window.skipSwitcher = true;
    window.keepAbove = true;
}

workspace.windowAdded.connect(protect);
workspace.windowList().forEach(protect);
