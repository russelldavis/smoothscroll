
//
// SmoothScroll (Balazs Galambosi)
// Licensed under the terms of the MIT license.
// The only restriction would be not to publish any
// extension for browsers or native application
// without getting a written permission first.
//

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
var root = document.documentElement;
/** @type HTMLElement */
var targetEl;

var key = { left: 37, up: 38, right: 39, down: 40, spacebar: 32,
            pageup: 33, pagedown: 34, end: 35, home: 36 };
var arrowKeys = { 37: 1, 38: 1, 39: 1, 40: 1 };

let cachedBestScrollable = null;
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
function init() {
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
        console.log("SmoothScroll is disabled due to quirks mode document with null scrollingElement");
        return;
    }

    let body = document.body;
    let html = document.documentElement;
    let windowHeight = window.innerHeight;
    let scrollHeight = body.scrollHeight;

    // Some properties like scrollTop are only set on either body or
    // documentElement, depending on quirks mode.
    // See https://bugs.chromium.org/p/chromium/issues/detail?id=157855.
    root = (document.compatMode.indexOf('CSS') >= 0) ? html : body;
    // @ts-ignore downcast
    targetEl = document.activeElement;

    // Checks if this script is running in a frame
    if (top !== self) {
        isFrame = true;
    }

    // TODO: check if clearfix is still needed
    else if (scrollHeight > windowHeight &&
            (body.clientHeight + 1 < body.scrollHeight &&
             html.clientHeight + 1 < html.scrollHeight)) {
        if (root.offsetHeight <= windowHeight) {
            let clearfix = document.createElement('div');
            clearfix.style.clear = 'both';
            body.appendChild(clearfix);
        }
    }

    // disable fixed background
    if (!options.fixedBackground && !isExcluded) {
        body.style.backgroundAttachment = 'scroll';
        html.style.backgroundAttachment = 'scroll';
    }

    addEvent('mousedown', mousedown);
    addEvent('keydown', keydown);
}

/**
 * Removes event listeners and other traces left on the page.
 */
function cleanup() {
    removeEvent('mousedown', mousedown);
    removeEvent('keydown', keydown);
}

/**
 * Make sure we are the last listener on the page so special
 * key event handlers (e.g for <video>) can come before us
 */
function loaded() {
    setTimeout(init, 1);
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

// Adapted from https://stackoverflow.com/a/47647393/278488
function isScrollable(el) {
    // offsetParent will be null if the element is `display:none` or has been
    // removed from the dom.
    if (!el.offsetParent) {
        return false;
    }
    // Example of a scrollable we want to find with overflow-y set to "auto":
    // https://www.notion.so/Founding-Engineer-710e5b15e6bd41ac9ff7f38ff153f929
    // Example for "scroll": gmail
    return ["scroll", "auto"].includes(getComputedStyle(el)["overflow-y"]);
}

function getBestScrollable() {
    if (!cachedBestScrollable || !isScrollable(cachedBestScrollable)) {
        cachedBestScrollable = findBestScrollable(document.body);
    }
    return cachedBestScrollable;
}

function findBestScrollable(root) {
    let scrollables = [];
    console.time("findBestScrollable");
    let walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT,
        {
            acceptNode: function(/** @type {Element} */ node) {
                if (isScrollable(node)) {
                    scrollables.push(node);
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_SKIP;
            }
        }
    );
    let res = walker.nextNode();
    console.assert(res === null, "nextNode returned non-null:", res)

    let maxWidth = 0;
    let widestEl = null;
    for (let scrollable of scrollables) {
        if (scrollable.clientWidth > maxWidth) {
            maxWidth = scrollable.clientWidth;
            widestEl = scrollable;
        }
    }
    console.timeEnd("findBestScrollable");
    return widestEl;
}

function shouldIgnoreKeydown(event) {
    let modifier = event.ctrlKey || event.altKey ||
                  (event.metaKey && event.keyCode !== key.down && event.keyCode !== key.up) ||
                  (event.shiftKey && event.keyCode !== key.spacebar);

    // do nothing if user is editing text
    // or using a modifier key (with some exceptions)
    // or in a dropdown
    // or inside interactive elements
    let inputNodeNames = /^(textarea|select|embed|object)$/i;
    let buttonTypes = /^(button|submit|radio|checkbox|file|color|image)$/i;
    if (event.defaultPrevented ||
        inputNodeNames.test(targetEl.nodeName) ||
        targetEl instanceof HTMLInputElement && !buttonTypes.test(targetEl.type) ||
        isNodeName(targetEl, 'video') ||
        isInsideYoutubeVideo(targetEl) ||
        targetEl.isContentEditable ||
        modifier
    ) {
        return true;
    }

    // [spacebar] should trigger button press, leave it alone
    if ((isNodeName(targetEl, 'button') ||
        targetEl instanceof HTMLInputElement && buttonTypes.test(targetEl.type)) &&
        event.keyCode === key.spacebar
    ) {
        return true;
    }

    // [arrwow keys] on radio buttons should be left alone
    if (targetEl instanceof HTMLInputElement && targetEl.type === 'radio' &&
        arrowKeys[event.keyCode]
    ) {
        return true;
    }
    return false;
}

/***********************************************
 * EVENTS
 ***********************************************/

/**
 * Keydown event handler.
 * @param {KeyboardEvent} event
 */
function keydown(event) {
    if (event.altKey && event.shiftKey && event.code === "Backslash") {
        isEnabled = !isEnabled;
        console.log("SmoothScroll enabled: " + isEnabled);
        event.preventDefault();
        return;
    }
    if (!isEnabled) return;

    // The notion-frame element existing means notion is done initializing.
    // (Before that, the notion-help-button element won't exist in either mode.)
    if (isNotion && document.querySelector(".notion-frame") != null) {
        // The help button only exists in editing mode, which we don't want to alter.
        if (
          (targetEl.nodeName === 'TEXTAREA' || targetEl.isContentEditable) &&
          document.querySelector(".notion-help-button") == null
        ) {
            console.log("Fixing scrolling for notion");
            targetEl = document.body;
        }
    }

    // Our own tracked active element could've been removed from the DOM (e.g. on twitter clicking
    // "Show more replies") or made invisible (e.g. on twitter when closing an image popup by
    // clicking outside it in the Gallery-closetarget grey area). Checking null offsetParent
    // catches either case. (Do nothing when targetEl is already document.body, since that
    // *never* has an offsetParent, and should never be getting removed or made invisible. We want
    // to keep the target as the body when a page (e.g. swift.org) has a scrollable body as well
    // as a scrollable child of body.
    if (targetEl !== document.body && !targetEl.offsetParent) {
        // @ts-ignore downcast
        targetEl = document.activeElement;
        // I think what this really wants to be doing is reusing `overflowing`
        // from the previous event, if it still exists. The original use case,
        // Twitter, no longer applies as they've changed their UI. Commenting it
        // out for now to see what breaks and then revisit it. (As-is, it's very
        // close to the existing getBestScrollble logic that already happens below.)
        //
        // if (targetEl === document.body) {
        //     // Chrome resets it to the body when an element goes away,
        //     // but often the thing that's being scrolled is a child.
        //     // Let's try to find it.
        //     for (let elem of document.body.children) {
        //         if (overflowingElement(elem)) {
        //             targetEl = elem;
        //             break;
        //         }
        //     }
        // }
    }

    // alt + up/down means "scroll no matter what"
    let forceScroll = event.altKey && event.keyCode === key.down || event.keyCode === key.up;
    if (!forceScroll && shouldIgnoreKeydown(event)) {
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
            let bestScrollable = getBestScrollable();
            console.log("No scrollable ancestor for:", targetEl)
            if (bestScrollable) {
                console.log("Using best scrollable instead:", bestScrollable)
                overflowing = bestScrollable;
                targetEl = bestScrollable;
            }
        }
    }

    if (!overflowing) {
        // If we're in a frame, the paren't won't get the keyboard event.
        // it *would* automatically scroll if we do nothing and return here,
        // but it wouldn't be our smooth scrolling. (When pressing the spacebar
        // inside an iframe, chrome has a bug where it won't scroll at all,
        // so our logic here also fixes that.)
        if (isFrame) {
            // TODO: send a message to the outer frame to do smooth scrolling.
        }
        return;
    }

    let clientHeight = overflowing.clientHeight;
    let shift, y = 0;

    switch (event.keyCode) {
        case key.up:
            if (!event.metaKey) {
                y = -options.arrowScroll;
                break;
            }
            // Fall through to treat cmd+up as home
        case key.home:
            y = -overflowing.scrollTop;
            break;
        case key.down:
            if (!event.metaKey) {
                y = options.arrowScroll;
                break;
            }
            // Fall through to treat cmd+down as end
        case key.end:
            let scroll = overflowing.scrollHeight - overflowing.scrollTop;
            let scrollRemaining = scroll - clientHeight;
            y = (scrollRemaining > 0) ? scrollRemaining+10 : 0;
            break;
        case key.spacebar: // (+ shift)
            shift = event.shiftKey ? 1 : -1;
            y = -shift * clientHeight * 0.9;
            break;
        case key.pageup:
            y = -clientHeight * 0.9;
            break;
        case key.pagedown:
            y = clientHeight * 0.9;
            break;
        default:
            return; // a key we don't care about
    }
    scrollArray(overflowing, 0, y);
    scheduleClearCache();
    event.preventDefault();
    if (!propagateScrollKeys) {
        event.stopPropagation();
    }
}

// Some sites have scrollable areas that are not focusable.[1] If you click them
// and press the arrow keys, they will scroll. Which element will scroll when
// you press the arrow keys is not exposed via any API. So we attempt to replicate
// what the browser is doing internally, tracking that element via targetEl.
//
// We set it here on mousedown to catch the non-focusable elements. We have a separate
// onFocus handler that will overwrite it when something gets focused.
// [1] Example: https://online-training.jbrains.ca/courses/the-jbrains-experience/lectures/5600334
// Discussion: https://stackoverflow.com/questions/497094/how-do-i-find-out-which-dom-element-has-the-focus
// Playground: http://jsfiddle.net/mklement/72rTF/
function mousedown(event) {
    targetEl = getInnerTarget(event);
}

function onFocus(event) {
    targetEl = getInnerTarget(event);
}

function getInnerTarget(event) {
    // See https://stackoverflow.com/questions/47737652/detect-if-dom-element-is-custom-web-component-or-html-element
    if (event.target.tagName?.includes("-") && event.composedPath) {
        // The target is a webcomponent. Get the real (inner) target.
        // See https://stackoverflow.com/questions/57963312/get-event-target-inside-a-web-component
        // @ts-ignore downcast
        return event.composedPath()[0];
    } else {
        return event.target;
    }
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

//  (body)                (root)
//         | hidden | visible | scroll |  auto  |
// hidden  |   no   |    no   |   YES  |   YES  |
// visible |   no   |   YES   |   YES  |   YES  |
// scroll  |   no   |   YES   |   YES  |   YES  |
// auto    |   no   |   YES   |   YES  |   YES  |

function overflowingAncestor(el) {
    let elems = [];
    let body = document.body;
    let rootScrollHeight = root.scrollHeight;
    do {
        let cached = getCache(el);
        if (cached) {
            return setCache(elems, cached);
        }
        elems.push(el);
        if (rootScrollHeight === el.scrollHeight) {
            let topOverflowsNotHidden = overflowNotHidden(root) && overflowNotHidden(body);
            let isOverflowCSS = topOverflowsNotHidden || overflowAutoOrScroll(root);
            if (isFrame && isContentOverflowing(root) ||
               !isFrame && isOverflowCSS) {
                return setCache(elems, root);
            }
        } else if (isContentOverflowing(el) && overflowAutoOrScroll(el)) {
            // Hack for pages where el is body and the `rootScrollHeight === el.scrollHeight` check above
            // isn't true because of some elements with margin/padding, e.g. at https://arp242.net/weblog/yaml_probably_not_so_great_after_all.html
            // TODO: fix this in a cleaner way
            if (el === document.body && isContentOverflowing(root)) {
                el = root;
            }
            return setCache(elems, el);
        }
    } while ((el = el.parentElement));
    return null;
}

// HACK: copied from overflowAncestor, just removed the loop
// function overflowingElement(el) {
//     let elems = [];
//     let body = document.body;
//     let rootScrollHeight = root.scrollHeight;
//     let cached = getCache(el);
//     if (cached) {
//         return setCache(elems, cached);
//     }
//     elems.push(el);
//     if (rootScrollHeight === el.scrollHeight) {
//         let topOverflowsNotHidden = overflowNotHidden(root) && overflowNotHidden(body);
//         let isOverflowCSS = topOverflowsNotHidden || overflowAutoOrScroll(root);
//         if (isFrame && isContentOverflowing(root) ||
//            !isFrame && isOverflowCSS) {
//             return setCache(elems, root);
//         }
//     } else if (isContentOverflowing(el) && overflowAutoOrScroll(el)) {
//         return setCache(elems, el);
//     }
//     return false;
// }

function isContentOverflowing(el) {
    return el.clientHeight + 10 < el.scrollHeight;
}

function computedOverflow(el) {
    return getComputedStyle(el, '').getPropertyValue('overflow-y');
}

// typically for <body> and <html>
function overflowNotHidden(el) {
    return (computedOverflow(el) !== 'hidden');
}

// for all other elements
function overflowAutoOrScroll(el) {
    return /^(scroll|auto)$/.test(computedOverflow(el));
}

function isScrollBehaviorSmooth(el) {
    let id = uniqueID(el);
    if (smoothBehaviorForElement[id] == null) {
        let scrollBehavior = getComputedStyle(el, '')['scroll-behavior'];
        smoothBehaviorForElement[id] = ('smooth' === scrollBehavior);
    }
    return smoothBehaviorForElement[id];
}

/***********************************************
 * HELPERS
 ***********************************************/

function addEvent(type, fn) {
    window.addEventListener(type, fn, true);
}

function removeEvent(type, fn) {
    window.removeEventListener(type, fn, true);
}

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

function isInsideYoutubeVideo(elem) {
    let isControl = false;
    if (document.URL.indexOf ('www.youtube.com/watch') !== -1) {
        do {
            isControl = (elem.classList &&
                         elem.classList.contains('html5-video-controls'));
            if (isControl) break;
        } while ((elem = elem.parentNode));
    }
    return isControl;
}

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

addEvent('load', loaded);
addEvent('focus', onFocus);
