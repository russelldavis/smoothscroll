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
let isAirtable = false;
let isSpreadsheetDotCom = false;

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
    if (document.domain === "airtable.com") {
        isAirtable = true;
    }
    if (document.domain === "app.spreadsheet.com") {
        isSpreadsheetDotCom = true;
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
    return getBestScrollable() != null;
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
    const scrollingEl = document.scrollingElement;
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

    // If document.scrollingElement is the body, the browser uses the scroll-behavior
    // property from document.documentElement instead.
    // See https://developer.mozilla.org/en-US/docs/Web/CSS/scroll-behavior
    // Example this applies to: https://gather.town/
    const scrollBehaviorElem =
        (elem === scrollingEl && scrollingEl === document.body) ? document.documentElement : elem;

    // if we haven't already fixed the behavior,
    // and it needs fixing for this sesh
    if (scrollBehaviorElem.$scrollBehavior == null && isScrollBehaviorSmooth(scrollBehaviorElem)) {
        scrollBehaviorElem.$scrollBehavior = scrollBehaviorElem.style.scrollBehavior;
        scrollBehaviorElem.$scrollBehaviorPriority = scrollBehaviorElem.style.getPropertyPriority("scroll-behavior");
        scrollBehaviorElem.style.setProperty("scroll-behavior", "auto", "important");
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
            if (scrollBehaviorElem.$scrollBehavior != null) {
                scrollBehaviorElem.style.setProperty(
                    "scroll-behavior",
                    scrollBehaviorElem.$scrollBehavior,
                    scrollBehaviorElem.$scrollBehaviorPriority
                );
                scrollBehaviorElem.$scrollBehavior = null;
                scrollBehaviorElem.$scrollBehaviorPriority = null;
            }
        }
    };

    // start a new queue of actions
    pending = window.requestAnimationFrame(step);
}

function getOffsetFromRoot(el) {
    let top = 0, left = 0;
    const elWindow = el.ownerDocument.defaultView;
    do {
        top += el.offsetTop || 0;
        left += el.offsetLeft || 0;
        el = el.offsetParent;
    } while(el);

    if (elWindow !== document.defaultView) {
        const frameEl = elWindow.frameElement;
        if (!frameEl) {
            // This happens if the iframe is cross-domain
            return null;
        }
        const offset = getOffsetFromRoot(frameEl);
        if (!offset) {
            return null;
        }
        top += offset.top;
        left += offset.left;
    }
    return {top, left};
}


// This doesn't catch every way of hiding an element, but it's good enough for now.
// See https://stackoverflow.com/questions/19669786/check-if-element-is-visible-in-dom
function visibleInDom(el) {
    // Example where checking visibility matters (after clicking the Read More link to open an overlay):
    // https://www.mazdausa.com/shopping-tools/build-and-price/2020-mazda3-sedan#s=1&tr=Automatic&d=AWD&f=Gasoline&t=20M3SSE%7C20M3SSEXA&ex=42M&in=V_BY3&p=&ip=1SE&o=&io=
    return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
}

function isScrollCandidate(el, checkVisibility = false) {
    if (checkVisibility && !visibleInDom(el)) {
        return false;
    }
    const ownerDoc = el.ownerDocument;
    const scrollingEl = ownerDoc.scrollingElement;

    // scrollingEl can be null in a rare compatibility mode (see comment in
    // onDOMContentLoaded), but it's not worth special casing, and in practice
    // it won't be null here since walkElements will skip iframes where
    // that's the case.
    if (scrollingEl === el) {
        // The body can be null when in iframe is first initialized, before the content has loaded.
        if (!ownerDoc.body) {
            return false;
        }
        return isRootScrollCandidate(ownerDoc.documentElement, ownerDoc.body)
    }

    // Note that when body has 'height: 100%' (or when in quirks mode) body and documentElement
    // will have identical clientHeight and scrollHeight, both indicating overflow when it exists.
    // But setting scrollTop will only work on scrollingEl.
    // Example: https://chromium-review.googlesource.com/c/chromium/src/+/2404277
    //
    // In a case where body and documentElement have 'height: 100%' *and* 'overflow-x: hidden',
    // documentElement will *not* indicate overflow, while body will (even though the
    // scrollingEl is documentElement).
    // Example: https://blog.coupler.io/linking-google-sheets/
    //
    // So, we special case the first case here, and the second case should just work since this
    // check will return false and `body` will be treated normally below.
    //
    // Due to the check above, we know at this point that el is not scrollingEl
    // (which means scrollingEl is documentElement).
    if (el === ownerDoc.body && isScrollable(scrollingEl)) {
        return false;
    }

    // If this is true, we know el isn't the scrollingEl, otherwise we'd have handled it above.
    // So we must be in quirks mode, and this will never be scrollable.
    // Example where this would seem to be scrollable even though it's not:
    // https://news.ycombinator.com/ if you set `height: 100%` on `body`.
    if (el === ownerDoc.documentElement) {
        return false;
    }

    // Example of a scrollable we want to find with overflow-y set to "auto":
    // https://www.notion.so/Founding-Engineer-710e5b15e6bd41ac9ff7f38ff153f929
    // Example for "scroll": gmail
    return overflowAutoOrScroll(el);
}

/** @returns HTMLElement */
function getBestScrollable() {
    // See comment above findBestScrollCandidate for details on why we do the caching like this
    if (!cachedBestScrollCandidate || !isScrollable(cachedBestScrollCandidate)) {
        cachedBestScrollCandidate = findBestScrollCandidate(document.documentElement);
        if (cachedBestScrollCandidate && !isScrollable(cachedBestScrollCandidate)) {
            return null;
        }
    }
    return cachedBestScrollCandidate;
}

const WALK_NO_CHILDREN = Symbol();
const WALK_CHILDREN = Symbol();
function walkElementsIncludingRoot(root, predicate) {
    const res = predicate(root);
    if (res !== WALK_NO_CHILDREN) {
        walkElements(root, predicate);
    }
}

// Finds elements where predicate returns true.
// Does not search children of matching elements.
function walkElements(root, predicate) {
    let walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT,
        {
            acceptNode: function(/** @type {Element} */ node) {
                let res = predicate(node);
                if (res === WALK_NO_CHILDREN) {
                    return NodeFilter.FILTER_REJECT;
                }
                if (node.shadowRoot) {
                    walkElements(node.shadowRoot, predicate);
                }
                // We inject our script into every iframe, so why do we need to handle them here (from their
                // parent)? Because we want to be able to scroll them (and/or their inner elements) when the
                // parent has the keyboard focus and the iframe is the best scrollable. We don't want to focus
                // the iframe because that would mess up the tab order, etc. We could try a postMessage approach
                // (like we do for scrolling the parent document from within an unscrollable iframe), but that
                // would be way more complicated (and the cross-origin use case so far seems very rare).
                //
                // Example: https://www.scootersoftware.com/v4help/index.html?command_line_reference.html
                if (node instanceof HTMLIFrameElement) {
                    let iframeDoc = node.contentDocument;
                    // contentDocument will be null if the iframe is cross origin. There's not much we can do
                    // in that case while keeping things synchronous — we can postMessage, but that's async.
                    //
                    // scrollingElement can be null in a rare compatibility mode (see comment in
                    // onDOMContentLoaded), but it's not trying to deal with that, so we just skip
                    // those iframes.
                    if (iframeDoc && iframeDoc.scrollingElement) {
                        walkElements(iframeDoc, predicate);
                    }
                }
                return NodeFilter.FILTER_SKIP;
            }
        }
    );
    let res = walker.nextNode();
    console.assert(res === null, "nextNode returned non-null:", res)
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

// NB: The reason we return "candidates" here and not just elements that are actually
// scrollable is for sites like gmail (in preview pane mode), where the preview pane is
// the desired scrolling element, but it may not be scrollable at page load, or when an
// arrow key is first pressed (but it *is* still a scroll candidate at those times).
//
// Sites like that may be pretty rare, in which case it may make sense to simplify this
// and just special-case it, or perhaps just stop caching the result of this function,
// which would also solve the problem.
/** @returns HTMLElement */
function findBestScrollCandidate(root) {
    let startTime = performance.now();
    let candidates = [];

    walkElementsIncludingRoot(root, (el) => {
        if (!visibleInDom(el)) {
            return WALK_NO_CHILDREN;
        }

        // No need to checkVisibility since we just did it above
        if (!isScrollCandidate(el, /* checkVisibility: */ false)) {
            return WALK_CHILDREN;
        }
        if (isOverflowing(el)) {
            candidates.push(el);
            return WALK_NO_CHILDREN;
        }
        // Now we have a scroll candidate that is not overflowing.
        // That element might contain a descendant scroll candidate that *is* overflowing.
        // In that case, we want to return the overflowing descendant. (Such a site probably
        // shouldn't be making the outer element a scroll candidate in the first place, but we
        // need to handle it regardless.)
        // Example site: https://autocode.com/
        const oldCandidatesLength = candidates.length;
        walkElements(el, (innerEl) => {
            if (!visibleInDom(el)) {
                return WALK_NO_CHILDREN;
            }
            // No need to checkVisibility since we just did it above
            if (isScrollable(innerEl, /* checkVisibility: */ false)) {
                candidates.push(innerEl);
                return WALK_NO_CHILDREN;
            }
            return WALK_CHILDREN;
        });
        if (oldCandidatesLength === candidates.length) {
            // Nothing rooted at el is overflowing (including el itself). Add el as a candidate
            // because it might overflow later, e.g. in gmail after selecting a message.
            candidates.push(el);
        }
        // We already walked all of el above.
        return WALK_NO_CHILDREN;
    });

    // Filter out offscreen elements. We do this here rather than in the visibleInDom check above
    // because it's an expensive operation that we don't want to do on every node.
    // Example where this matters (when trying to scroll the document with spacebar in Viewing mode):
    // https://docs.google.com/document/d/1smLAXs-DSLLmkEt4FIPP7PVglJXOcwRc7A5G0SEwxaY/edit#heading=h.hykhktoizkjj
    candidates = candidates.filter((candidate) => {
        const offset = getOffsetFromRoot(candidate);
        // When offset is null, we don't know if it's offscreen or not (due to a cross-domain
        // iframe). This hasn't actually come up yet, but I'm erring towards including them
        // as candidates until for now.
        return !offset ||
            ((offset.left + candidate.scrollWidth) > 0) &&
            ((offset.top + candidate.scrollHeight) > 0);
    });

    let best = maxBy(candidates, el => el.clientWidth * el.clientHeight);

    // Not logging this before first keypress because it gets called a lot and spams the console.
    if (didFirstKeypress) {
        console.debug(
          "findBestScrollCandidate: %s ms, result: %o",
          (performance.now() - startTime).toFixed(1),
          best
        );
    }
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

    // In airtable's grid mode, let airtable use the keys to navigate individual cells
    if (isAirtable && document.querySelector(".cell.cursor")) {
        return true;
    }

    // On spreadsheet.com, only do smoothscrolling if the active element itself is scrollable,
    // i.e., don't look for a scrollable ancestor or the best scrollable. We let the app handle
    // that, since it will just navigate the grid. (We allow for a scrollable activeElement for
    // cases like the Automations modal that has a scrollable inner section).
    if (isSpreadsheetDotCom && !isScrollable(document.activeElement)) {
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
    const keyData = new KeyData(event);
    const inputTarget = overrideInputTarget(getInnerTarget(event));
    let scrollTarget = inputTarget;
    // See onMouseDown for details on the activeClickedEl handling.
    if (activeClickedEl != null) {
        // activeClickedEl could've been removed from the DOM (e.g. on twitter clicking
        // "Show more replies") or made invisible (e.g. on twitter when closing an image
        // popup by clicking outside it in the Gallery-closetarget grey area).
        if (visibleInDom(activeClickedEl)) {
            scrollTarget = activeClickedEl;
        } else {
            activeClickedEl = null;
            console.debug("activeClickedEl element is no longer valid; scrolling body");
        }
    }
    handleKeyData(inputTarget, scrollTarget, keyData, event);
}

function overrideInputTarget(inputTarget) {
    // The notion-frame element existing means notion is done initializing.
    // (Before that, the notion-help-button element won't exist in either mode.)
    // NB: Notion allows custom domains, so don't restrict this check to just notion.so.
    if (document.querySelector(".notion-frame") != null) {
        // The help button only exists in editing mode, which we don't want to alter.
        if (
          (inputTarget.nodeName === 'TEXTAREA' || inputTarget.isContentEditable) &&
          document.querySelector(".notion-help-button") == null
        ) {
            return document.body;
        }
    }
    return inputTarget;
}

/**
 * See the comment in onMouseDown for why we need separate parameters for
 * inputTarget and scrollTarget.
 * @param {HTMLElement} inputTarget
 * @param {HTMLElement} scrollTarget
 * @param {KeyData} keyData
 * @param {IEventActions} actions
 */
function handleKeyData(inputTarget, scrollTarget, keyData, actions) {
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

    // alt + up/down means "scroll no matter what"
    let forceScroll = keyData.altKey && (keyData.keyCode === keyToCode.down || keyData.keyCode === keyToCode.up);
    if (!forceScroll && inputTarget && shouldIgnoreKeydown(inputTarget, keyData)) {
        return;
    }

    let scrollable;
    if (forceBestScrollable) {
        scrollable = getBestScrollable();
    } else {
        scrollable = scrollableAncestor(scrollTarget);

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
            // see `overrideInputTarget`.)
            //
            // Other sites where this fixes keyboard scrolling:
            // https://firstmonday.org/ojs/index.php/fm/article/view/7925/6630
            // https://install.advancedrestclient.com/install
            // https://www.scootersoftware.com/v4help/index.html?command_line_reference.html
            console.debug("No scrollable ancestor for:", scrollTarget)
            let bestScrollable = getBestScrollable();
            if (bestScrollable) {
                console.debug("Using best scrollable instead:", bestScrollable)
                scrollable = bestScrollable;
            }
        }
    }

    if (!scrollable) {
        // If we're in a frame, the parent won't get the keyboard event.
        // It *would* automatically scroll if we do nothing and return here,
        // but it wouldn't be our smooth scrolling. (Also, when pressing the spacebar
        // inside certain iframes (e.g. on Amazon), chrome has a bug where it
        // won't scroll at all, so our logic here fixes that too.)
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
        // If this click causes an onFocus event, we don't always want that event to
        // clear out activeClickedEl, because the element getting the focus might
        // not be the click target itself (because the click target might not be
        // focusable but might have an ancestor that is).
        //
        // In those cases, the browser doesn't normally let you scroll the click target
        // via the keyboard, but we want to fix that. So we set activeClickedEl after
        // the event loop runs, so the onFocus event will run first (if it runs at all).
        //
        // Note: if the focus went to an input element, that needs to take precedence over
        // this for input handling (otherwise we'll end up swallowing the spacebar, for
        // example); that gets taken care of in onKeyDown by having separate elements for
        // inputTarget and scrollTarget. To see the bug that fixes, set this timeout to something
        // larger like 2000 (it can happen with the current timeout of 0 as well, but it's harder
        // to replicate), then change the call to handleKeyData in onKeyDown to pass in
        // scrollTarget instead of inputTarget for the first argument. Then click on an input
        // element, e.g. at doordash.com, and press the spacebar after 2 seconds.
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
    if (data?.id !== SCROLL_MSG_ID) {
        return;
    }

    event.stopImmediatePropagation();
    // Don't think there's a default action, but we don't want it if there ever is
    event.preventDefault();

    // NB: This won't result in the contents of the iframe getting scrolled, but
    // rather ensures that we scroll the overflowing ancestor of the iframe (in case
    // there are multiple scrollables).
    /** @type HTMLElement */
    let scrollTarget = getIframeForEvent(event);
    if (scrollTarget == null) {
        scrollTarget = document.body;
        console.warn("Couldn't find iframe for smoothscroll message");
    }
    // Passing in null for inputTarget, since we've already handled the input
    // filtering here in this iframe.
    // Passing in a dummy event for IEventActions, which will be no-ops.
    handleKeyData(null, scrollTarget, data.keyData, new Event("dummy"))
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

function isRootScrollCandidate(docEl, body) {
    return overflowAutoOrScroll(docEl) ||
        (overflowNotHidden(docEl) && overflowNotHidden(body))
}

function isScrollable(el, checkVisibility = true) {
    return isScrollCandidate(el, checkVisibility) && isOverflowing(el);
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
    while(true) {
        let cached = getCache(el);
        if (cached) {
            return setCache(elems, cached);
        }

        elems.push(el);
        if (isScrollable(el)) {
            return setCache(elems, el);
        }

        let nextEl = el.assignedSlot ?? el.parentElement ?? getShadowRootHost(el);
        if (nextEl == null) {
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

// Test cases:
//
// Clicking on an iframe where the container is larger than the body.
// Example: https://www.scootersoftware.com/v4help/index.html?command_line_reference.html
// (after clicking on left sidebar).
//
// Quirks mode.
// Example: https://news.ycombinator.com/
//
// Site that changes document.compatMode via document.write as it loads.
// (Could potentially affect things if it changes document.scrollingElement and that was being
// cached somewhere.)
// Example: https://metaphorhacker.net/2021/01/the-nonsense-of-style-academic-writing-should-be-scrupulous-not-stylish/
