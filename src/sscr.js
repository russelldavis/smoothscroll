//
// SmoothScroll (Balazs Galambosi)
// Licensed under the terms of the MIT license.
// The only restriction would be not to publish any
// extension for browsers or native application
// without getting a written permission first.
//
// Sites to test:
// webcomponents: https://chromium-review.googlesource.com/c/chromium/src/+/2404277

const SCROLL_MSG_ID = "01f116cd-717b-42fc-ab68-932cd0ce961d"

// Scroll Variables (tweakable)
var defaultOptions = {

    // Scrolling Core
    frameRate        : 150, // [Hz]
    animationTime    : 400, // [px]
    stepSize         : 100, // [px]

    // Pulse (less tweakable)
    // ratio of 'tail' to 'acceleration'
    pulseAlgorithm   : true,
    pulseScale       : 4,
    pulseNormalize   : 1,

    // Acceleration
    accelerationDelta : 50,  // 20
    accelerationMax   : 3,   // 1

    keyboardSupport   : true,  // option
    arrowScroll       : 50,     // [px]

    // Other
    fixedBackground   : true,
    excluded          : ''
};

var options = defaultOptions;


// Other Variables
var isEnabled = true;
var isExcluded = false;
var isFrame = false;
var direction = { x: 0, y: 0 };
// This gets modified in onLoad
var root = document.documentElement;

const keyToCode = {
    up: 38, down: 40, spacebar: 32, pageup: 33, pagedown: 34, end: 35, home: 36
};
const scrollKeyCodes = new Set(Object.values(keyToCode));
const arrowKeyCodes = new Set([keyToCode.up, keyToCode.down]);

let cachedBestScrolCandidate = null;
// Use the "best" scrollable area, even if there's a different scrollable area
// that's an ancestor of the active element. Set this to true for sites like
// gmail where you want to scroll the message pane regardless of the active
// element.
let forceBestScrollable = false;
// Controls whether a key event that we translate into a scroll gets propagated.
// Set this to false for sites like gmail that have their own JS event handlers
// that would conflict with our scrolling behavior.
// UPDATE: I'm now trying out setting to false for everything. Can't think of a
// case where it needs to be true
let propagateScrollKeys = false;
let isNotion = false;
let listeners = [];
// See onMouseDown for details
let activeUnfocusedEl = null;
let shouldLogEvents = false;


/***********************************************
 * SETTINGS
 ***********************************************/

chrome.storage.sync.get(defaultOptions, function (syncedOptions) {

    // @ts-ignore
    options = syncedOptions;

    // it seems that sometimes settings come late
    // and we need to test again for excluded pages
    initWithOptions();
});


/***********************************************
 * INITIALIZE
 ***********************************************/

/**
 * Tests if smooth scrolling is allowed. Shuts down everything if not.
 */
function initWithOptions() {
    // disable everything if the page is blacklisted
    let domains = options.excluded.split(/[,\n] ?/);
    domains.push('play.google.com/music'); // problem with Polymer elements
    domains.push('strava.com'); // slow scrolling for some reason
    for (let i = domains.length; i--;) {
        // domains[i] can be empty if options.excluded is empty, or if there are blank lines
        if (domains[i] && (document.URL.indexOf(domains[i]) > -1)) {
            console.log("SmoothScroll is disabled for " + domains[i]);
            isExcluded = true;
            cleanup();
            return;
        }
    }
    if (document.URL.startsWith("https://mail.google.com")) {
        forceBestScrollable = true;
        propagateScrollKeys = false;
    }
    if (document.URL.startsWith("https://www.mlb.com")) {
        // Without this, scrolling is broken (just freezes) if you hold down
        // an arrow key (even without this extension installed at all).
        propagateScrollKeys = false;
    }
    if (document.URL.startsWith("https://www.notion.so")) {
        isNotion = true;
    }
}

/**
 * Sets up scrolls array, determines if frames are involved.
 */
function onLoad() {
    if (isExcluded || !document.body) {
        return;
    }

    if (!document.scrollingElement) {
        // document.scrollingElement is only null in a rare circumstance that's not worth special-casing:
        // when the document is in quirks mode and the body element is "potentially scrollable" which only
        // seems to be true when, for example, both the html element and the body element have a property
        // like `overflow-x: hidden`. See https://drafts.csswg.org/cssom-view/#dom-document-scrollingelement
        // for details.
        //
        // To handle those pages, we'd need to replace a bunch of properties like document.scrollTop with
        // their equivalent from the window object (like window.scrollY). Not currently a priority.
        //
        // Example quirks mode page for testing: http://strictquirks.nl/quirks/?mode=c
        console.log("SmoothScroll is disabled due to quirks mode document with null scrollingElement");
        return;
    }

    let body = document.body;
    let html = document.documentElement;

    // Some properties like scrollTop are only set on either body or
    // documentElement, depending on quirks mode.
    // See https://bugs.chromium.org/p/chromium/issues/detail?id=157855.
    // Now that we don't support document.scrollingElement being null (see above),
    // we could probably set this to that instead.
    root = (document.compatMode.indexOf('CSS') >= 0) ? html : body;
    // Temporary to see if switching the logic above will break anything
    if (root !== document.scrollingElement) {
        alert("Smoothscroll: root differs from scrollingElement. See console.");
        console.log("root:", root);
        console.log("scrollingElement", document.scrollingElement);
    }

    // Checks if this script is running in a frame
    if (top !== self) {
        isFrame = true;
    }

    // disable fixed background
    if (!options.fixedBackground) {
        body.style.backgroundAttachment = 'scroll';
        html.style.backgroundAttachment = 'scroll';
    }

    let hostname = new URL(document.URL).hostname;
    if (
      // Example: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3800408/
      hostname.endsWith("ncbi.nlm.nih.gov") ||
      hostname.endsWith("yahoo.com")
    ) {
        // These pages start with the search bar focused, which prevents
        // scrolling with the keyboard.
        // @ts-ignore downcast
        document.activeElement.blur();
    }
}

/************************************************
 * SCROLLING
 ************************************************/

var que = [];
var pending = null;
var lastScroll = Date.now();

/**
 * Pushes scroll actions to the scrolling queue.
 */
function scrollArray(elem, left, top) {
    directionCheck(left, top);
    if (options.accelerationMax !== 1) {
        var now = Date.now();
        var elapsed = now - lastScroll;
        if (elapsed < options.accelerationDelta) {
            var factor = (1 + (50 / elapsed)) / 2;
            if (factor > 1) {
                factor = Math.min(factor, options.accelerationMax);
                left *= factor;
                top  *= factor;
            }
        }
        lastScroll = Date.now();
    }

    // push a scroll command
    que.push({
        x: left,
        y: top,
        lastX: (left < 0) ? 0.99 : -0.99,
        lastY: (top  < 0) ? 0.99 : -0.99,
        start: Date.now()
    });

    // don't act if there's a pending frame loop
    if (pending) {
        return;
    }

    // if we haven't already fixed the behavior,
    // and it needs fixing for this sesh
    if (elem.$scrollBehavior == null && isScrollBehaviorSmooth(elem)) {
        elem.$scrollBehavior = elem.style.scrollBehavior;
        elem.style.scrollBehavior = 'auto';
    }

    var step = function (_time) {

        var now = Date.now();
        var scrollX = 0;
        var scrollY = 0;

        for (var i = 0; i < que.length; i++) {
            var item = que[i];
            var elapsed  = now - item.start;
            var finished = (elapsed >= options.animationTime);

            // scroll position: [0, 1]
            var position = (finished) ? 1 : elapsed / options.animationTime;

            // easing [optional]
            if (options.pulseAlgorithm) {
                position = pulse(position);
            }

            // only need the difference
            var x = (item.x * position - item.lastX) >> 0;
            var y = (item.y * position - item.lastY) >> 0;

            // add this to the total scrolling
            scrollX += x;
            scrollY += y;

            // update last values
            item.lastX += x;
            item.lastY += y;

            // delete and step back if it's over
            if (finished) {
                que.splice(i, 1); i--;
            }
        }

        if (window.devicePixelRatio) {
            //scrollX /= (window.devicePixelRatio;
            //scrollY /= window.devicePixelRatio;
        }

        if (scrollX) elem.scrollLeft += scrollX;
        if (scrollY) elem.scrollTop  += scrollY;

        // clean up if there's nothing left to do
        if (!left && !top) {
            que = [];
        }

        if (que.length) {
            pending = window.requestAnimationFrame(step);
        } else {
            pending = null;
            // restore default behavior at the end of scrolling sesh
            if (elem.$scrollBehavior != null) {
                elem.style.scrollBehavior = elem.$scrollBehavior;
                elem.$scrollBehavior = null;
            }
        }
    };

    // start a new queue of actions
    pending = window.requestAnimationFrame(step);
}

// This doesn't catch every way of hiding an element, but it good enough for now.
// See https://stackoverflow.com/questions/19669786/check-if-element-is-visible-in-dom
function visibleInDom(el) {
    return el.getClientRects().length > 0;
}

function isScrollCandidate(el) {
    if (!visibleInDom(el)) {
        return false;
    }
    // We inject our script into every iframe, so why do we need to handle them here (from their
    // parent)? Because we want to be able to scroll them when the parent has the keyboard focus
    // and the iframe is the best scrollable. We don't want to focus the iframe because that
    // would mess up the tab order, etc. We could try a postMessage approach (like we do for
    // scrolling the parent document from within an unscrollable iframe), but that would be way
    // more complicated (and the cross-origin use case so far seems very rare).
    if (el instanceof HTMLIFrameElement) {
        // contentDocument will be null if the iframe is cross origin. There's not much we can do
        // in that case while keeping things synchronous — we can postMessage, but that's async.
        // scrollingElement will be null in a rare compatibility mode (see comment in onLoad); in
        // that case treating it as nonscrollable is good enough.
        //
        // Note that the HTMLIFrameElement element itself isn't actually scrollable — its inner
        // scrollingElement is. But it ends up being easiest to just return true for this element
        // type and then special case it in getBestScrollable.
        let innerScrollingEl = el.contentDocument?.scrollingElement;
        // TODO: also check that its overflow isn't set to hidden
        return innerScrollingEl && isOverflowing(innerScrollingEl);
    }
    // Example of a scrollable we want to find with overflow-y set to "auto":
    // https://www.notion.so/Founding-Engineer-710e5b15e6bd41ac9ff7f38ff153f929
    // Example for "scroll": gmail
    return ["scroll", "auto"].includes(computedOverflowY(el));
}

/** @returns HTMLElement */
function getBestScrollable() {
    if (!cachedBestScrolCandidate || !isScrollCandidate(cachedBestScrolCandidate)) {
        cachedBestScrolCandidate = findBestScrollCandidate(document.body);
    }
    if (cachedBestScrolCandidate instanceof HTMLIFrameElement) {
        // No need to check isOverflowing here — isScrollCandidate (called above)
        // already handles it for iframe elements.
        return cachedBestScrolCandidate.contentDocument.scrollingElement;
    } else if (isOverflowing(cachedBestScrolCandidate)) {
        return cachedBestScrolCandidate;
    } else {
        return null;
    }
}

// Finds elements where predicate returns true.
// Does not search children of matching elements.
function findOuterElements(root, predicate) {
    let matches = [];
    let walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT,
        {
            acceptNode: function(/** @type {Element} */ node) {
                if (predicate(node)) {
                    matches.push(node);
                    return NodeFilter.FILTER_REJECT;
                }
                if (node.shadowRoot) {
                    matches.push(
                        ...findOuterElements(node.shadowRoot, predicate)
                    );
                }
                return NodeFilter.FILTER_SKIP;
            }
        }
    );
    let res = walker.nextNode();
    console.assert(res === null, "nextNode returned non-null:", res)
    return matches;
}

function maxBy(collection, fn) {
    let maxVal = -Infinity;
    let maxItem = null;
    for (let item of collection) {
        let itemVal = fn(item);
        if (itemVal > maxVal) {
            maxVal = itemVal;
            maxItem = item;
        }
    }
    return maxItem;
}

/** @returns HTMLElement */
function findBestScrollCandidate(root) {
    let startTime = performance.now();
    let candidates = findOuterElements(root, el => isScrollCandidate(el));
    let best = maxBy(candidates, el => el.clientWidth * el.clientHeight);
    console.debug("findBestScrollCandidate: %s ms", (performance.now() - startTime).toFixed(1));
    return best;
}

function shouldIgnoreKeydown(targetEl, keyData) {
    if (!scrollKeyCodes.has(keyData.keyCode)) {
        return true;
    }

    let modifier = keyData.ctrlKey || keyData.altKey ||
                  (keyData.metaKey && keyData.keyCode !== keyToCode.down && keyData.keyCode !== keyToCode.up) ||
                  (keyData.shiftKey && keyData.keyCode !== keyToCode.spacebar);

    // do nothing if user is editing text
    // or using a modifier key (with some exceptions)
    // or in a dropdown
    // or inside interactive elements
    let inputNodeNames = /^(textarea|select|embed|object)$/i;
    let buttonTypes = /^(button|submit|radio|checkbox|file|color|image)$/i;
    if (inputNodeNames.test(targetEl.nodeName) ||
        targetEl instanceof HTMLInputElement && !buttonTypes.test(targetEl.type) ||
        targetEl.isContentEditable ||
        modifier
    ) {
        return true;
    }

    // [spacebar] should trigger button press, leave it alone
    if ((isNodeName(targetEl, 'button') ||
        targetEl instanceof HTMLInputElement && buttonTypes.test(targetEl.type)) &&
        keyData.keyCode === keyToCode.spacebar
    ) {
        return true;
    }

    // [arrwow keys] on radio buttons should be left alone
    if (targetEl instanceof HTMLInputElement && targetEl.type === 'radio' &&
        arrowKeyCodes.has(keyData.keyCode)
    ) {
        return true;
    }
    return false;
}

class KeyData {
    constructor({code, keyCode, altKey, shiftKey, metaKey, ctrlKey}) {
        this.code = code;
        this.keyCode = keyCode;
        this.altKey = altKey;
        this.shiftKey = shiftKey;
        this.metaKey = metaKey;
        this.ctrlKey = ctrlKey;
    }
}

/***********************************************
 * EVENTS
 ***********************************************/

class IEventActions {
    preventDefault() {}
    stopImmediatePropagation() {}
}

/**
 * @param {KeyboardEvent} event
 */
function onKeyDown(event) {
    let targetEl = getInnerTarget(event);
    // See onMouseDown for why we do this.
    if ((targetEl === document.body || targetEl == null) && activeUnfocusedEl != null) {
        // activeUnfocusedEl could've been removed from the DOM (e.g. on twitter clicking
        // "Show more replies") or made invisible (e.g. on twitter when closing an image
        // popup by clicking outside it in the Gallery-closetarget grey area).
        if (visibleInDom(activeUnfocusedEl)) {
            targetEl = activeUnfocusedEl;
        } else {
            activeUnfocusedEl = null;
            console.debug("activeUnfocusedEl element is no longer valid; scrolling body");
        }
    }
    handleKeyData(targetEl, new KeyData(event), event);
}

function overrideTargetEl(targetEl) {
    // The notion-frame element existing means notion is done initializing.
    // (Before that, the notion-help-button element won't exist in either mode.)
    if (isNotion && document.querySelector(".notion-frame") != null) {
        // The help button only exists in editing mode, which we don't want to alter.
        if (
          (targetEl.nodeName === 'TEXTAREA' || targetEl.isContentEditable) &&
          document.querySelector(".notion-help-button") == null
        ) {
            return document.body;
        }
    }
    return targetEl;
}

/**
 * @param {HTMLElement} targetEl
 * @param {KeyData} keyData
 * @param {IEventActions} actions
 */
function handleKeyData(targetEl, keyData, actions) {
    if (keyData.altKey && keyData.shiftKey && keyData.code === "Backslash") {
        isEnabled = !isEnabled;
        console.log("SmoothScroll enabled: " + isEnabled);
        actions.preventDefault();
        return;
    }
    if (!isEnabled) return;

    targetEl = overrideTargetEl(targetEl);

    // alt + up/down means "scroll no matter what"
    let forceScroll = keyData.altKey && (keyData.keyCode === keyToCode.down || keyData.keyCode === keyToCode.up);
    if (!forceScroll && shouldIgnoreKeydown(targetEl, keyData)) {
        return;
    }

    let overflowing;
    if (forceBestScrollable) {
        overflowing = getBestScrollable();
    } else {
        overflowing = overflowingAncestor(targetEl);
        // We don't do this if we're a frame, otherwise we may find a suboptimal
        // scrollable and prevent the main scrollable in the parent from scrolling
        // (reproduce by clicking in the comments section at the bottom of
        // https://online-training.jbrains.ca/courses/the-jbrains-experience/lectures/5600334).
        if (!overflowing && !isFrame) {
            // We couldn't find a scrollable ancestor. Look for the best
            // scrollable in the whole document.
            //
            // Example where this is used: notion docs, e.g.:
            // https://www.notion.so/Founding-Engineer-710e5b15e6bd41ac9ff7f38ff153f929
            // They have a fixed header and non-scrolling body. Instead,
            // there's a scrollable div buried in the dom that this finds.
            // (They normally handle scrolling themselves but we override it;
            // see `isNotion`.)
            //
            // Other sites where this fixes keyboard scrolling:
            // https://firstmonday.org/ojs/index.php/fm/article/view/7925/6630
            // https://install.advancedrestclient.com/install
            // https://www.scootersoftware.com/v4help/index.html?command_line_reference.html
            let bestScrollable = getBestScrollable();
            console.debug("No scrollable ancestor for:", targetEl)
            if (bestScrollable) {
                console.debug("Using best scrollable instead:", bestScrollable)
                overflowing = bestScrollable;
            }
        }
    }

    if (!overflowing) {
        // If we're in a frame, the parent won't get the keyboard event.
        // It *would* automatically scroll if we do nothing and return here,
        // but it wouldn't be our smooth scrolling. (When pressing the spacebar
        // inside certain iframes (e.g. on Amazon), chrome has a bug where it
        // won't scroll at all, so our logic here also fixes that.)
        if (isFrame) {
            parent.postMessage({id: SCROLL_MSG_ID, keyData: keyData}, "*")
            actions.stopImmediatePropagation();
            actions.preventDefault();
        }
        return;
    }

    let clientHeight = overflowing.clientHeight;
    let shift, y = 0;

    switch (keyData.keyCode) {
        case keyToCode.up:
            if (!keyData.metaKey) {
                y = -options.arrowScroll;
                break;
            }
            // Fall through to treat cmd+up as home
        case keyToCode.home:
            y = -overflowing.scrollTop;
            break;
        case keyToCode.down:
            if (!keyData.metaKey) {
                y = options.arrowScroll;
                break;
            }
            // Fall through to treat cmd+down as end
        case keyToCode.end:
            let scroll = overflowing.scrollHeight - overflowing.scrollTop;
            let scrollRemaining = scroll - clientHeight;
            y = (scrollRemaining > 0) ? scrollRemaining+10 : 0;
            break;
        case keyToCode.spacebar: // (+ shift)
            shift = keyData.shiftKey ? 1 : -1;
            y = -shift * clientHeight * 0.9;
            break;
        case keyToCode.pageup:
            y = -clientHeight * 0.9;
            break;
        case keyToCode.pagedown:
            y = clientHeight * 0.9;
            break;
        default:
            return; // a key we don't care about
    }
    scrollArray(overflowing, 0, y);
    scheduleClearCache();
    actions.preventDefault();
    if (!propagateScrollKeys) {
        actions.stopImmediatePropagation();
    }
}

function logEvent(event, extra) {
    if (!shouldLogEvents) {
        return;
    }
    console.log(
      `${event.type}: ${extra ?? ''}`,
      event,
    );
}

// Some sites have scrollable areas that are not focusable. If you click them
// and press the arrow keys, they will scroll, but the target of the keydown events
// will be the document body. And there's no API that exposes which element would
// scroll in such cases. So we attempt to replicate what the browser is doing
// internally, tracking that element via activeUnfocusedEl.
//
// We set it here on mousedown and clear it in onFocus, so it will have a value
// only when a mousedown is not followed by a focus event, which is the exactly
// the scenario described above.
//
// Example: https://online-training.jbrains.ca/courses/the-jbrains-experience/lectures/5600334
// Discussion: https://stackoverflow.com/questions/497094/how-do-i-find-out-which-dom-element-has-the-focus
// Playground: http://jsfiddle.net/mklement/72rTF/
function onMouseDown(event) {
    // Example site that relies on checking defaultPrevented:
    // https://www.typescriptlang.org/play (monaco editor)
    if (!event.defaultPrevented) {
        activeUnfocusedEl = getInnerTarget(event);
    }
    logEvent(event);
}

function onFocus(event) {
    // We only want events inside the document. Could also fix this by listening on
    // document instead of window, but for now keeping that consistent for all events.
    if (event.target instanceof Window) {
        return;
    }
    activeUnfocusedEl = null;
    logEvent(event);
}

function getInnerTarget(event) {
    if (event.target.shadowRoot) {
        // The target is a webcomponent. Get the real (inner) target.
        // See https://stackoverflow.com/questions/57963312/get-event-target-inside-a-web-component
        // Example page with webcomponents where this applies: https://install.advancedrestclient.com/install
        // @ts-ignore downcast
        return event.composedPath()[0];
    } else {
        return event.target;
    }
}

function getIframeForEvent(event) {
    let iframes = document.getElementsByTagName('iframe');
    for(let iframe of iframes) {
        if(event.source === iframe.contentWindow) {
            return iframe;
        }
    }
    return null;
}

function onMessage(event) {
    let data = event.data;
    if (data.id !== SCROLL_MSG_ID) {
        return;
    }

    event.stopImmediatePropagation();
    // Don't think there's a default action, but we don't want it if there ever is
    event.preventDefault();

    // NB: This won't result in the contents of the iframe getting scrolled, but
    // rather ensures that we scroll the overflowing ancestor of the iframe (in case
    // there are multiple scrollables).
    /** @type HTMLElement */
    let targetEl = getIframeForEvent(event);
    if (targetEl == null) {
        targetEl = document.body;
        console.warn("Couldn't find iframe for smoothscroll message");
    }
    // Pass in a dummy event for IEventActions, which will be no-ops
    handleKeyData(targetEl, data.keyData, new Event("dummy"))
}

/***********************************************
 * OVERFLOW
 ***********************************************/

var uniqueID = (function () {
    var i = 0;
    return function (el) {
        return el.uniqueID || (el.uniqueID = i++);
    };
})();

var cacheY = {}; // cleared out after a scrolling session
var clearCacheTimer;
var smoothBehaviorForElement = {};

function scheduleClearCache() {
    clearTimeout(clearCacheTimer);
    clearCacheTimer = setInterval(function () {
        cacheY = {};
        smoothBehaviorForElement = {};
    }, 1000);
}

function setCache(elems, overflowing) {
    for (let i = elems.length; i--;)
        cacheY[uniqueID(elems[i])] = overflowing;
    return overflowing;
}

function getCache(el) {
    return cacheY[uniqueID(el)];
}

function getShadowRootHost(el) {
    let res = el.getRootNode();
    return (res instanceof HTMLDocument) ? null : res.host;
}

//  (body)                (root)
//         | hidden | visible | scroll |  auto  |
// hidden  |   no   |    no   |   YES  |   YES  |
// visible |   no   |   YES   |   YES  |   YES  |
// scroll  |   no   |   YES   |   YES  |   YES  |
// auto    |   no   |   YES   |   YES  |   YES  |

/** @returns HTMLElement */
function overflowingAncestor(el) {
    let elems = [];
    let body = document.body;
    let docEl = document.documentElement;
    while(true) {
        let cached = getCache(el);
        if (cached) {
            return setCache(elems, cached);
        }
        elems.push(el);
        // Note that when body has 'height: 100%' (or when in quirks mode) body and documentElement
        // will have identical clientHeight and scrollHeight, both potentially indicating overflow.
        // But setting scrollTop will only work on scrollingElement (root). So we start this logic
        // as soon as we hit body, but we operate on root.
        // Example: https://chromium-review.googlesource.com/c/chromium/src/+/2404277
        //
        // Note: we normally won't hit the el === docEl case, since we'd usually hit body first
        // while traversing up the tree. But this function might be called directly with docEl
        // in a case where the user has clicked on an iframe where the container is larger than
        // the body. Example: https://www.scootersoftware.com/v4help/index.html?command_line_reference.html
        // (after clicking on left sidebar).
        if (el === body || el === docEl) {
            if (
              isOverflowing(root) &&
              (overflowAutoOrScroll(docEl) ||
                (overflowNotHidden(docEl) && overflowNotHidden(body)))
            ) {
                return setCache(elems, root);
            }
            return null;
        }
        if (isOverflowing(el) && overflowAutoOrScroll(el)) {
            return setCache(elems, el);
        }
        let nextEl = el.assignedSlot ?? el.parentElement ?? getShadowRootHost(el);
        if (nextEl == null) {
            console.warn("Couldn't find next ancestor element for: ", el);
            return null;
        }
        el = nextEl;
    }
}

function isOverflowing(el) {
    return el.scrollHeight > el.clientHeight;
}

function computedOverflowY(el) {
    return getComputedStyle(el).overflowY;
}

// typically for <body> and <html>
function overflowNotHidden(el) {
    return (computedOverflowY(el) !== 'hidden');
}

// for all other elements
function overflowAutoOrScroll(el) {
    return /^(scroll|auto)$/.test(computedOverflowY(el));
}

function isScrollBehaviorSmooth(el) {
    let id = uniqueID(el);
    if (smoothBehaviorForElement[id] == null) {
        let scrollBehavior = getComputedStyle(el)['scroll-behavior'];
        smoothBehaviorForElement[id] = ('smooth' === scrollBehavior);
    }
    return smoothBehaviorForElement[id];
}

/***********************************************
 * HELPERS
 ***********************************************/

function isNodeName(el, tag) {
    return el && (el.nodeName||'').toLowerCase() === tag.toLowerCase();
}

function directionCheck(x, y) {
    x = (x > 0) ? 1 : -1;
    y = (y > 0) ? 1 : -1;
    if (direction.x !== x || direction.y !== y) {
        direction.x = x;
        direction.y = y;
        que = [];
        lastScroll = 0;
        window.cancelAnimationFrame(pending);
        pending = null;
    }
}

// function isInsideYoutubeVideo(elem) {
//     if (document.URL.indexOf ('www.youtube.com/watch') !== -1) {
//         do {
//             if (elem.classList?.contains('html5-video-player')) {
//                 return true;
//             }
//         } while ((elem = elem.parentNode));
//     }
//     return false;
// }

/***********************************************
 * PULSE (by Michael Herf)
 ***********************************************/

/**
 * Viscous fluid with a pulse for part and decay for the rest.
 * - Applies a fixed force over an interval (a damped acceleration), and
 * - Lets the exponential bleed away the velocity over a longer interval
 * - Michael Herf, http://stereopsis.com/stopping/
 */
function pulse_(x) {
    let val, start, expx;
    // test
    x = x * options.pulseScale;
    if (x < 1) { // acceleartion
        val = x - (1 - Math.exp(-x));
    } else {     // tail
        // the previous animation ended here:
        start = Math.exp(-1);
        // simple viscous drag
        x -= 1;
        expx = 1 - Math.exp(-x);
        val = start + (expx * (1 - start));
    }
    return val * options.pulseNormalize;
}

function pulse(x) {
    if (x >= 1) return 1;
    if (x <= 0) return 0;

    if (options.pulseNormalize === 1) {
        options.pulseNormalize /= pulse_(1);
    }
    return pulse_(x);
}

/************* Listeners *************/

function cleanup() {
    while(listeners.length > 0) {
        window.removeEventListener.apply(window, listeners.pop());
    }
}

function addListener(type, listener, useCapture) {
    // We listen on `window` rather than `document` so we get events first.
    window.addEventListener(type, listener, useCapture);
    listeners.push([type, listener, useCapture]);
}

function addListeners() {
    // This gets called multiple times, so clear listeners first.
    // The browser already makes re-adding a no-op, no need to explicitly
    // removeListener (directly or indirectly via cleanup()).
    listeners = [];
    addListener('load', onLoad, true);
    addListener("message", onMessage, true);
    addListener('keydown', onKeyDown, true);
    addListener('focus', onFocus, true);
    // We want the non-capturing phase for mousedown events so we
    // can act based on event.defaultPrevented. In the rare case that
    // stopPropagation() is called and preventDefault() is *not* called,
    // we'll miss a relevant event, but that should be super rare and
    // this is the best we can do.
    //
    // Note that preventDefault() does nothing for focus events, so we
    // continue to use the capture phase for those so we don't have to
    // worry about them not getting propagation.
    addListener('mousedown', onMouseDown, false);
}

addListeners();

// This is a hack to make things work in documents that rewrite themselves using
// document.open(). When they do that, the document gets reset, and all of our
// listeners get lost. This re-adds them. This event gets sent by background.js.
//
// In particular, this applies to amazon product pages, which use document.open()
// to dynamically generate an iframe.
//
// We can't monkeypatch document.open from this context (content_script). We could
// inject a script into the page context, but it's hard for the page to communicate
// back once document.open gets called, because all handlers (including for message
// events) get cleared. So we just do this unconditionally. Re-adding the listeners
// is a cheap no-op anyway. We could probably get away with making this the *only*
// place where we add the listeners, but I'm keeping the call above to ensure we add
// them as early as possible in the common case.
chrome.runtime.onMessage.addListener((request, _sender, _sendResponse) => {
    if (request.event === "onCommitted") {
        addListeners();
    }
});
