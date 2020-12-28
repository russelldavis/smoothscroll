const shouldLogEvents = false;

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
// This gets modified in onDOMContentLoaded
var root = document.documentElement;

const keyToCode = {
    up: 38, down: 40, spacebar: 32, pageup: 33, pagedown: 34, end: 35, home: 36
};
const scrollKeyCodes = new Set(Object.values(keyToCode));
const arrowKeyCodes = new Set([keyToCode.up, keyToCode.down]);

let cachedBestScrollCandidate = null;
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
let shouldClearFocus = true;
let listeners = [];
// See onMouseDown for details
let activeClickedEl = null;
let clearedInitialFocusWhileNotHidden = false;
let didFirstKeypress = false;

function init() {
    if (document.URL.startsWith("https://mail.google.com")) {
        forceBestScrollable = true;
        propagateScrollKeys = false;
    }
    if (document.URL.startsWith("https://www.mlb.com")) {
        // Without this, scrolling is broken (just freezes) if you hold down
        // an arrow key (even without this extension installed at all).
        propagateScrollKeys = false;
    }
    if (document.URL.startsWith("https://www.diigo.com/post")) {
        shouldClearFocus = false;
    }
}

function onOptionsLoaded(loadedOptions) {
    options = loadedOptions;

    // disable everything if the page is blacklisted
    let domains = options.excluded.split(/[,\n] ?/);
    domains.push('play.google.com/music'); // problem with Polymer elements
    domains.push('strava.com'); // slow scrolling for some reason
    for (let i = domains.length; i--;) {
        // domains[i] can be empty if options.excluded is empty, or if there are blank lines
        if (domains[i] && (document.URL.indexOf(domains[i]) > -1)) {
            console.log("SmoothScroll is disabled for " + domains[i]);
            isExcluded = true;
            removeListeners();
            return;
        }
    }
}

function onDOMContentLoaded() {
    if (isExcluded) {
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
        removeListeners();
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

    isFrame = (top !== self);

    // disable fixed background
    if (!options.fixedBackground) {
        body.style.backgroundAttachment = 'scroll';
        html.style.backgroundAttachment = 'scroll';
    }

    // Not sure yet how to best handle focus in frames, ignore them for now.
    if (!isFrame) {
        tryClearInitialFocus(20);
    }
}

function tryClearInitialFocus(numTries) {
    // Some sites set the focus after the onLoad event, so we keep trying for a bit.
    // Examples:
    //    https://www.philo.com/login/subscribe
    //    https://news.yahoo.com/mark-kelly-win-ariz-senate-153623807.html
    if (!clearInitialFocus() && numTries > 0) {
        setTimeout(tryClearInitialFocus, 50, numTries - 1);
    }
}

function anythingIsScrollable() {
    return (
        isRootScrollable(root, document.documentElement, document.body) ||
        getBestScrollable() != null
    );
}

// Sites that start with a focused input:
// https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3800408/
// https://mimestream.com/
function clearInitialFocus() {
    if (!document.hidden) {
        clearedInitialFocusWhileNotHidden = true;
    }

    if (!shouldClearFocus) {
        return true;
    }

    // If there's nothing to scroll, clearing the focus would be counterproductive.
    // Could even consider setting the focus to an input if it's not there already.
    if (!anythingIsScrollable()) {
        return false;
    }

    // This is needed for sites like https://www.yahoo.com/ that will otherwise
    // refocus the element
    let els = document.querySelectorAll('[autofocus]')
    for (let el of els) {
        // @ts-ignore We know the prop exists because we queried for it
        el.autofocus = false;
    }

    if (document.activeElement instanceof HTMLInputElement) {
        document.activeElement.blur();
        return true;
    }
    return false;
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
    //
    // Example: https://www.scootersoftware.com/v4help/index.html?command_line_reference.html
    if (el instanceof HTMLIFrameElement) {
        // contentDocument will be null if the iframe is cross origin. There's not much we can do
        // in that case while keeping things synchronous — we can postMessage, but that's async.
        // scrollingElement will be null in a rare compatibility mode (see comment in
        // onDOMContentLoaded); in that case treating it as nonscrollable is good enough.
        //
        // Note that the HTMLIFrameElement element itself isn't actually scrollable — its inner
        // scrollingElement is. But it ends up being easiest to just return true for this element
        // type and then special case it in getBestScrollable.
        let doc = el.contentDocument;
        let scrollingEl = doc?.scrollingElement;
        // See comments on similar check of document.scrollingElement in onDOMContentLoaded
        return scrollingEl != null && isRootScrollable(scrollingEl, doc.documentElement, doc.body);
    }
    // Example of a scrollable we want to find with overflow-y set to "auto":
    // https://www.notion.so/Founding-Engineer-710e5b15e6bd41ac9ff7f38ff153f929
    // Example for "scroll": gmail
    return ["scroll", "auto"].includes(computedOverflowY(el));
}

/** @returns HTMLElement */
function getBestScrollable() {
    if (cachedBestScrollCandidate == null || !isScrollCandidate(cachedBestScrollCandidate)) {
        cachedBestScrollCandidate = findBestScrollCandidate(document.body);
        if (cachedBestScrollCandidate == null) {
            return null;
        }
    }
    if (cachedBestScrollCandidate instanceof HTMLIFrameElement) {
        // No need to check isOverflowing here — isScrollCandidate (called above)
        // already handles it for iframe elements (via isRootScrollable).
        return cachedBestScrollCandidate.contentDocument.scrollingElement;
    } else if (isOverflowing(cachedBestScrollCandidate)) {
        return cachedBestScrollCandidate;
    } else {
        console.debug("cachedBestScrollCandidate is not overflowing");
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
                let res = predicate(node);
                if (res) {
                    if (Array.isArray(res)) {
                        matches.push(...res);
                    } else {
                        matches.push(node);
                    }
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

    let candidates = findOuterElements(root, (el) => {
        if (!isScrollCandidate(el)) {
            return false;
        }
        if (isOverflowing(el)) {
            return true;
        }
        // The rest of this handles the following case:
        // A page might have a scroll candidate that is *not* overflowing which contains
        // a descendant scroll candidate that *is* overflowing. In that case, we want to return the
        // overflowing descendant. (Such a site probably shouldn't be making the outer element
        // a scroll candidate in the first place, but we need to handle it regardless.)
        // Example site: https://autocode.com/
        let overflowingEls = findOuterElements(
            el,
            innerEl => isScrollCandidate(innerEl) && isOverflowing(innerEl)
        );
        // When nothing is overflowing (including el itself), return true to use el as a candidate
        // (it might overflow later, e.g. in gmail after selecting a message).
        return overflowingEls.length === 0 ? true : overflowingEls;
    });

    let best = maxBy(candidates, el => el.clientWidth * el.clientHeight);
    console.debug(
      "findBestScrollCandidate: %s ms, result: %o",
      (performance.now() - startTime).toFixed(1),
      best
    );
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
    // See onMouseDown for details on the activeClickedEl handling.
    if (activeClickedEl != null) {
        // activeClickedEl could've been removed from the DOM (e.g. on twitter clicking
        // "Show more replies") or made invisible (e.g. on twitter when closing an image
        // popup by clicking outside it in the Gallery-closetarget grey area).
        if (visibleInDom(activeClickedEl)) {
            targetEl = activeClickedEl;
        } else {
            activeClickedEl = null;
            console.debug("activeClickedEl element is no longer valid; scrolling body");
        }
    }
    handleKeyData(targetEl, new KeyData(event), event);
}

function overrideTargetEl(targetEl) {
    // The notion-frame element existing means notion is done initializing.
    // (Before that, the notion-help-button element won't exist in either mode.)
    // NB: Notion allows custom domains, so don't restrict this check to just notion.so.
    if (document.querySelector(".notion-frame") != null) {
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

    if (!arrowKeyCodes.has(keyData.keyCode)) {
        // Don't clear the focus after user input
        shouldClearFocus = false;
    }
    if (!didFirstKeypress) {
        didFirstKeypress = true;
        // We have no way of knowing when an arbitrary web page will be done
        // initializing and updating the DOM. For now, we reset this cache on
        // the first keypress, which in most cases should happen after that's
        // all finished.
        cachedBestScrollCandidate = null;
    }

    targetEl = overrideTargetEl(targetEl);

    // alt + up/down means "scroll no matter what"
    let forceScroll = keyData.altKey && (keyData.keyCode === keyToCode.down || keyData.keyCode === keyToCode.up);
    if (!forceScroll && shouldIgnoreKeydown(targetEl, keyData)) {
        return;
    }

    let scrollable;
    if (forceBestScrollable) {
        scrollable = getBestScrollable();
    } else {
        scrollable = scrollableAncestor(targetEl);
        // We don't do this if we're a frame, otherwise we may find a suboptimal
        // scrollable and prevent the main scrollable in the parent from scrolling
        // (reproduce by clicking in the comments section at the bottom of
        // https://online-training.jbrains.ca/courses/the-jbrains-experience/lectures/5600334).
        if (!scrollable && !isFrame) {
            // We couldn't find a scrollable ancestor. Look for the best
            // scrollable in the whole document.
            //
            // Example where this is used: notion docs, e.g.:
            // https://www.notion.so/Founding-Engineer-710e5b15e6bd41ac9ff7f38ff153f929
            // They have a fixed header and non-scrolling body. Instead,
            // there's a scrollable div buried in the dom that this finds.
            // (They normally handle scrolling themselves but we override it;
            // see `overrideTargetEl`.)
            //
            // Other sites where this fixes keyboard scrolling:
            // https://firstmonday.org/ojs/index.php/fm/article/view/7925/6630
            // https://install.advancedrestclient.com/install
            // https://www.scootersoftware.com/v4help/index.html?command_line_reference.html
            let bestScrollable = getBestScrollable();
            console.debug("No scrollable ancestor for:", targetEl)
            if (bestScrollable) {
                console.debug("Using best scrollable instead:", bestScrollable)
                scrollable = bestScrollable;
            }
        }
    }

    if (!scrollable) {
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

    // If scroll snapping is set to mandatory, let the browser do the scrolling. Otherwise
    // small scroll increments will just end up snapping back to the original location,
    // making scrolling impossible.
    // Example: https://www.tesla.com/
    // @ts-ignore scrollSnapType is valid
    let sst = getComputedStyle(scrollable).scrollSnapType;
    // This assumes the block axis is the Y axis. Could fix this by checking writing-mode.
    if (sst === 'y mandatory' || sst === 'both mandatory' || sst === 'block mandatory') {
        return;
    }

    let clientHeight = scrollable.clientHeight;
    let shift, y = 0;

    switch (keyData.keyCode) {
        case keyToCode.up:
            if (!keyData.metaKey) {
                y = -options.arrowScroll;
                break;
            }
            // Fall through to treat cmd+up as home
        case keyToCode.home:
            y = -scrollable.scrollTop;
            break;
        case keyToCode.down:
            if (!keyData.metaKey) {
                y = options.arrowScroll;
                break;
            }
            // Fall through to treat cmd+down as end
        case keyToCode.end:
            let scroll = scrollable.scrollHeight - scrollable.scrollTop;
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
            // This should never happen — shouldIgnoreKeydown should filter
            // out any keys we don't handle above.
            console.warn("Smoothscroll: unexpected keycode: ", keyData.keyCode);
            return;
    }
    scrollArray(scrollable, 0, y);
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
// will be the document body.
// Example: https://online-training.jbrains.ca/courses/the-jbrains-experience/lectures/5600334
//
// Other sites have something similar, but with a parent element that is focusable.
// On these sites, the browser won't scroll the scrollable area at all (but we'd
// like to fix that in this extension).
// Example: https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-document-history.html
//
// There's no API that exposes which element would (or should) scroll in such cases.
// So we attempt to replicate what the browser is doing internally, tracking that
// element via activeClickedEl.
//
// Discussion: https://stackoverflow.com/questions/497094/how-do-i-find-out-which-dom-element-has-the-focus
// Playground: http://jsfiddle.net/mklement/72rTF/
function onMouseDown(event) {
    // Example site that relies on checking defaultPrevented:
    // https://www.typescriptlang.org/play (monaco editor)
    if (!event.defaultPrevented) {
        // If this click causes an onFocus event, we don't want that event to
        // clear out activeClickedEl, because the element getting the focus could
        // might not be the click target itself (because the click target might not
        // be focusable but might have an ancestor that is).
        //
        // In those cases, the browser doesn't normally let you scroll the click target
        // via the keyboard, but we want to fix that. So we set activeClickedEl after
        // the event loop runs, so the onFocus event will run first (if it runs at all).
        // Example: https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-document-history.html
        setTimeout(() => {
            activeClickedEl = getInnerTarget(event);
        }, 0);
    }
    // Don't clear the focus after user input
    shouldClearFocus = false;
    logEvent(event);
}

function onFocus(event) {
    if (event.target instanceof Window) {
        if (!clearedInitialFocusWhileNotHidden) {
            tryClearInitialFocus(10);
        }
        return;
    }
    // Something else got the focus, so the clicked element is no longer "active".
    activeClickedEl = null;
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

function isRootScrollable(scrollingEl, docEl, body) {
    // We can't just pick either docEl or body to pass to isOverflowing;
    // it has to be the document's scrollingElement.
    // Example (quirks mode): https://news.ycombinator.com/
    return (
      isOverflowing(scrollingEl) &&
      (overflowAutoOrScroll(docEl) ||
        (overflowNotHidden(docEl) && overflowNotHidden(body)))
    )
}

//  (body)                (root)
//         | hidden | visible | scroll |  auto  |
// hidden  |   no   |    no   |   YES  |   YES  |
// visible |   no   |   YES   |   YES  |   YES  |
// scroll  |   no   |   YES   |   YES  |   YES  |
// auto    |   no   |   YES   |   YES  |   YES  |

/** @returns HTMLElement */
function scrollableAncestor(el) {
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
            if (isRootScrollable(root, docEl, body)) {
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

function removeListeners() {
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
    // removeListener (directly or indirectly via removeListeners()).
    listeners = [];
    addListener('DOMContentLoaded', onDOMContentLoaded, true);
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

// Sites to test:
// webcomponents: https://chromium-review.googlesource.com/c/chromium/src/+/2404277
function main() {
    init();
    chrome.storage.sync.get(defaultOptions, onOptionsLoaded);
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
}

main();