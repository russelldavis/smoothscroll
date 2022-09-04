
var defaultOptions = {

    // Plugin
    middleMouse       : true,

    // Scrolling Core
    framerate         : 150, // [Hz]
    animationTime     : 400, // [px]
    stepSize          : 120, // [px]

    // Pulse (less tweakable)
    // ratio of "tail" to "acceleration"
    pulseAlgorithm    : true,
    pulseScale        : 4,
    pulseNormalize    : 1,

    // Acceleration
    accelerationDelta : 20,  // 20
    accelerationMax   : 1,   // 1

    // Keyboard Settings
    keyboardSupport   : true,  // option
    arrowScroll       : 50,    // [px]

    // Other
    touchpadSupport   : true,
    fixedBackground   : true,
    excluded          : "example.com, another.example.com"
}

function init(details) {
    if (details.reason === "install") {
        void chrome.storage.sync.set(defaultOptions);
        var optionsPage = chrome.runtime.getURL("pages/options.html");
        void chrome.tabs.create({ url: optionsPage });
        chrome.tabs.query({}, function (tabs) {
            tabs.forEach(addSmoothScrollToTab);
        });
    }
}

function addSmoothScrollToTab(tab) {
    void chrome.tabs.executeScript(tab.id, {
        file: "src/sscr.js",
        allFrames: true
    });
}

function onCommitted(details) {
    // See the onMessage listener in sscr.js for why we need this.
    chrome.tabs.sendMessage(
        details.tabId, {event: "onCommitted"}, {frameId: details.frameId}
    );
}

// Fired when the extension is first installed,
// when the extension is updated to a new version,
// and when Chrome is updated to a new version.
chrome.runtime.onInstalled.addListener(init);

// Fired when each frame starts loading.
// IMPORTANT: this will fail (chrome.webNavigation will be undefined) if you reload the extension
// in chrome. You need to manually unload and load the extension to avoid it.
// See https://stackoverflow.com/a/55095222/278488
chrome.webNavigation.onCommitted.addListener(onCommitted);
