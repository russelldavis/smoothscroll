
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
var initDone  = false;
var root = document.documentElement;
var targetElement;
var isMac = /^Mac/.test(navigator.platform);
var isWin = /Windows/i.test(navigator.userAgent);

var key = { left: 37, up: 38, right: 39, down: 40, spacebar: 32,
            pageup: 33, pagedown: 34, end: 35, home: 36 };
var arrowKeys = { 37: 1, 38: 1, 39: 1, 40: 1 };

/***********************************************
 * SETTINGS
 ***********************************************/

chrome.storage.sync.get(defaultOptions, function (syncedOptions) {

    options = syncedOptions;

    // it seems that sometimes settings come late
    // and we need to test again for excluded pages
    initTest();
});


/***********************************************
 * INITIALIZE
 ***********************************************/

/**
 * Tests if smooth scrolling is allowed. Shuts down everything if not.
 */
function initTest() {
    // disable everything if the page is blacklisted
    if (options.excluded) {
        var domains = options.excluded.split(/[,\n] ?/);
        domains.push('mail.google.com'); // exclude Gmail for now
        domains.push('play.google.com/music'); // problem with Polymer elements
        for (var i = domains.length; i--;) {
            if (document.URL.indexOf(domains[i]) > -1) {
                isExcluded = true;
                cleanup();
                return;
            }
        }
    }
}

/**
 * Sets up scrolls array, determines if frames are involved.
 */
function init() {
    if (initDone || isExcluded || !document.body) {
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

    initDone = true;

    var body = document.body;
    var html = document.documentElement;
    var windowHeight = window.innerHeight;
    var scrollHeight = body.scrollHeight;

    // Some properties like scrollTop are only set on either body or
    // documentElement, depending on quirks mode.
    // See https://bugs.chromium.org/p/chromium/issues/detail?id=157855.
    root = (document.compatMode.indexOf('CSS') >= 0) ? html : body;
    targetElement = body;

    // Checks if this script is running in a frame
    if (top != self) {
        isFrame = true;
    }

    // TODO: check if clearfix is still needed
    else if (scrollHeight > windowHeight &&
            (body.clientHeight + 1 < body.scrollHeight &&
             html.clientHeight + 1 < html.scrollHeight)) {
        if (root.offsetHeight <= windowHeight) {
            var clearfix = document.createElement('div');
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

    if (options.accelerationMax != 1) {
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

    var step = function (time) {

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
        }
    };

    // start a new queue of actions
    pending = window.requestAnimationFrame(step);
}


/***********************************************
 * EVENTS
 ***********************************************/

/**
 * Keydown event handler.
 * @param {Object} event
 */
function keydown(event) {
    if (event.altKey && event.shiftKey && event.code === "Backslash") {
        isEnabled = !isEnabled;
        console.log("SmoothScroll enabled: " + isEnabled);
        event.preventDefault();
        return false;
    }
    if (!isEnabled) return true;

    var target   = event.target;
    var modifier = event.ctrlKey || event.altKey ||
                  (event.metaKey && event.keyCode !== key.down && event.keyCode !== key.up) ||
                  (event.shiftKey && event.keyCode !== key.spacebar);

    // Our own tracked active element could've been removed from the DOM (e.g. on twitter clicking
    // "Show more replies") or made invisible (e.g. on twitter when closing an image popup by
    // clicking outside it in the Gallery-closetarget grey area). Checking null offsetParent
    // catches either case. (Do nothing when targetElement is already document.body, since that
    // *never* has an offsetParent, and should never be getting removed or made invisible. We want
    // to keep the target as the body when a page (e.g. swift.org) has a scrollable body as well
    // as a scrollable child of body.
    if (targetElement !== document.body && !targetElement.offsetParent) {
        targetElement = document.activeElement;
        if (targetElement === document.body) {
            // Chrome resets it to the body when an element goes away,
            // but often the thing that's being scrolled is a child.
            // Let's try to find it.
            for (let elem of document.body.children) {
                if (overflowingElement(elem)) {
                    targetElement = elem;
                    break;
                }
            }
        }
    }

    // do nothing if user is editing text
    // or using a modifier key (except shift)
    // or in a dropdown
    // or inside interactive elements
    var inputNodeNames = /^(textarea|select|embed|object)$/i;
    var buttonTypes = /^(button|submit|radio|checkbox|file|color|image)$/i;
    if ( event.defaultPrevented ||
         inputNodeNames.test(target.nodeName) ||
         isNodeName(target, 'input') && !buttonTypes.test(target.type) ||
         isNodeName(targetElement, 'video') ||
         isInsideYoutubeVideo(event) ||
         target.isContentEditable ||
         modifier ) {
      return true;
    }

    // [spacebar] should trigger button press, leave it alone
    if ((isNodeName(target, 'button') ||
         isNodeName(target, 'input') && buttonTypes.test(target.type)) &&
        event.keyCode === key.spacebar) {
      return true;
    }

    // [arrwow keys] on radio buttons should be left alone
    if (isNodeName(target, 'input') && target.type == 'radio' &&
        arrowKeys[event.keyCode])  {
      return true;
    }

    var xOnly = (event.keyCode == key.left || event.keyCode == key.right);
    var overflowing = overflowingAncestor(targetElement);

    if (!overflowing) {
        // iframes seem to eat key events, which we need to propagate up
        // if the iframe has nothing overflowing to scroll
        return isFrame ? parent.keydown(event) : true;
    }

    var clientHeight = overflowing.clientHeight;
    var shift, y = 0;

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
            var scroll = overflowing.scrollHeight - overflowing.scrollTop;
            var scrollRemaining = scroll - clientHeight;
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
            return true; // a key we don't care about
    }

    scrollArray(overflowing, 0, y);
    event.preventDefault();
    scheduleClearCache();
}

/**
 * Mousedown event only for updating targetElement.
 * This is necessary because, depending on the properties of the element being
 * clicked on, the browser might not update document.activeElement, even when
 * clicking on an element with scrollbars.
 */
function mousedown(event) {
    targetElement = event.target;
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

function scheduleClearCache() {
    clearTimeout(clearCacheTimer);
    clearCacheTimer = setInterval(function () {
        cacheY = {};
    }, 1*1000);
}

function setCache(elems, overflowing) {
    for (var i = elems.length; i--;)
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
    var elems = [];
    var body = document.body;
    var rootScrollHeight = root.scrollHeight;
    var rootScrollWidth  = root.scrollWidth;
    do {
        var cached = getCache(el);
        if (cached) {
            return setCache(elems, cached);
        }
        elems.push(el);
        if (rootScrollHeight === el.scrollHeight) {
            var topOverflowsNotHidden = overflowNotHidden(root) && overflowNotHidden(body);
            var isOverflowCSS = topOverflowsNotHidden || overflowAutoOrScroll(root);
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
}

// HACK: copied from overflowAncestor, just removed the loop
function overflowingElement(el) {
    var elems = [];
    var body = document.body;
    var rootScrollHeight = root.scrollHeight;
    var rootScrollWidth  = root.scrollWidth;
    var cached = getCache(el);
    if (cached) {
        return setCache(elems, cached);
    }
    elems.push(el);
    if (rootScrollHeight === el.scrollHeight) {
        var topOverflowsNotHidden = overflowNotHidden(root) && overflowNotHidden(body);
        var isOverflowCSS = topOverflowsNotHidden || overflowAutoOrScroll(root);
        if (isFrame && isContentOverflowing(root) ||
           !isFrame && isOverflowCSS) {
            return setCache(elems, root);
        }
    } else if (isContentOverflowing(el) && overflowAutoOrScroll(el)) {
        return setCache(elems, el);
    }
    return false;
}

function isContentOverflowing(el) {
    return el.clientHeight + 10 < el.scrollHeight;
}

function computedOverflow(el) {
    return getComputedStyle(el, '').getPropertyValue('overflow-y');
}

// typically for <body> and <html>
function overflowNotHidden(el) {
    return (computedOverflow(el) != 'hidden');
}

// for all other elements
function overflowAutoOrScroll(el) {
    return /^(scroll|auto)$/.test(computedOverflow(el));
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

function isInsideYoutubeVideo(event) {
    var elem = event.target;
    var isControl = false;
    if (document.URL.indexOf ('www.youtube.com/watch') != -1) {
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
    var val, start, expx;
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

    if (options.pulseNormalize == 1) {
        options.pulseNormalize /= pulse_(1);
    }
    return pulse_(x);
}

addEvent('load', loaded);
