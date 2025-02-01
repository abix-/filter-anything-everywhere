// content.ts
import $ from 'jquery';
import { getCanonicalHostname } from './hostname.js';
import { GetOptions } from './options_storage';
import { regexpFromWordList } from './word_matcher.js';

// Extend the Window interface for custom properties.
declare global {
  interface Window {
    hasAqi?: boolean;
  }
}

// Mark that the content script is active.
window.hasAqi = true;

// Domain setting key types.
type DomainBoolMapName = 'hide_completely' | 'disable_site';

// A small tolerance (in pixels) used when comparing dimensions.
const TOLERANCE = 5;

// The minimum number of similar siblings required for feed-like detection.
const min_feed_neighbors = 3;

/**
 * Fetches a boolean status (e.g. hide_completely, disable_site) for the current host.
 */
async function fetchStatusForHost(key: DomainBoolMapName): Promise<boolean> {
  try {
    const currentHost = getCanonicalHostname(window.location.host);
    const items = await GetOptions();
    if (!items[key]) return false;
    return items[key][currentHost] === true;
  } catch (err) {
    console.error(`Error fetching status for host: ${err}`);
    return false;
  }
}

/**
 * Compares two DOMRect objects for similarity with a tolerance.
 * Returns true if the dimensions are approximately equal.
 */
function isSimilar(myRect: DOMRect, sibRect: DOMRect): boolean {
  const myCenterX = myRect.left + myRect.width / 2;
  const sibCenterX = sibRect.left + sibRect.width / 2;
  const myCenterY = myRect.top + myRect.height / 2;
  const sibCenterY = sibRect.top + sibRect.height / 2;

  const isVerticallyPlaced = Math.abs(myCenterY - sibCenterY) > Math.abs(myCenterX - sibCenterX);

  if (isVerticallyPlaced) {
    // Compare widths within a tolerance; ignore if sibling has zero height.
    return sibRect.height !== 0 && Math.abs(myRect.width - sibRect.width) <= TOLERANCE;
  } else {
    // Compare heights within a tolerance.
    return Math.abs(myRect.height - sibRect.height) <= TOLERANCE;
  }
}

/**
 * Finds the most “feed-like” ancestor of a given node.
 * It examines the node and its parents to find an element that has similar sibling elements.
 * Returns a jQuery object wrapping an HTMLElement.
 */
function getFeedlikeAncestor(node: Node): JQuery<HTMLElement> {
  // Gather the node and all its parents.
  const $parents = $(node).add($(node).parents());
  
  // Calculate a "sibling similarity" count for each element.
  const siblingnessCounts = $parents.map((index, elem) => {
    // LI elements get a high similarity count.
    if ($(elem).prop('tagName') === 'LI') {
      return min_feed_neighbors + 1;
    }
    if (!(elem instanceof Element)) {
      return 0;
    }
    const rect = elem.getBoundingClientRect();
    // Skip elements with zero height.
    if (rect.height === 0) {
      return 0;
    }
    // Count siblings with similar dimensions.
    const matchingSiblings = $(elem)
      .siblings()
      .filter((index, sib) => {
        if (!(sib instanceof Element)) {
          return false;
        }
        const sibRect = sib.getBoundingClientRect();
        return isSimilar(rect, sibRect);
      });
    return Math.min(matchingSiblings.length, min_feed_neighbors);
  });
  
  // Identify the parent element with the highest similarity count.
  let bestCount = -1;
  let bestIndex = -1;
  for (let i = siblingnessCounts.length - 1; i >= 0; i--) {
    const count = siblingnessCounts[i];
    if (count > bestCount) {
      bestCount = count;
      bestIndex = i;
    }
  }
  
  // Retrieve the chosen element from the jQuery collection.
  let chosenElement: Node | undefined;
  if (bestIndex < 0) {
    console.error('No suitable feed-like ancestor found; defaulting to the original node.');
    chosenElement = node;
  } else {
    chosenElement = $parents.get(bestIndex);
    if (!chosenElement) {
      console.error('No element found at bestIndex; defaulting to the original node.');
      chosenElement = node;
    }
  }
  
  // Ensure that the chosen element is an HTMLElement.
  if (!(chosenElement instanceof HTMLElement)) {
    if (chosenElement && chosenElement.parentElement) {
      chosenElement = chosenElement.parentElement;
    } else {
      chosenElement = document.createElement('div');
    }
  }
  
  return $(chosenElement as HTMLElement);
}

/**
 * Finds the ID of the iframe containing this document.
 */
function findMyId(): string {
  try {
    const iframes = parent.document.getElementsByTagName('iframe');
    for (let i = 0; i < iframes.length; i++) {
      if (
        document === iframes[i].contentDocument ||
        self === iframes[i].contentWindow
      ) {
        return iframes[i].id;
      }
    }
  } catch (err) {
    console.error(`Error finding iframe ID: ${err}`);
  }
  return '';
}

/**
 * Returns the iframe ID or a placeholder string if not found.
 */
function findMyIdOrPlaceHolder(): string {
  const id = findMyId();
  return id || 'ignore';
}

// Store the identifier for the current frame.
const my_id = findMyIdOrPlaceHolder();

/**
 * Checks whether the current script is running inside an iframe.
 */
function inIframe(): boolean {
  try {
    return window.self !== window.top;
  } catch (e) {
    return true;
  }
}

/**
 * Adds a notification element to the specified DOM element.
 * The notification can be inserted either inside or before the element.
 */
function addNotification(elem: JQuery<HTMLElement>, putInside: boolean): void {
  const $elem = $(elem);
  
  // Ignore if the element is a window.
  if ($.isWindow($elem)) {
    console.log('Ignoring window for notification.');
    return;
  }
  
  // Prevent duplicate notifications.
  if (putInside && $elem.children('.aqi-notification').length !== 0) {
    return;
  }
  if (!putInside && $elem.prev('.aqi-notification').length !== 0) {
    return;
  }
  
  // Create notification container and content.
  const $positioner = $('<div/>').addClass('aqi-notification');
  const $contents = $('<div/>').addClass('aqi-inside');
  const width = $elem.width();
  
  if (width === undefined) {
    console.warn('Cannot determine width of element!');
  } else {
    $contents.css('max-width', width.toString());
  }
  
  // Create an arrow element that dismisses the notification on click.
  const $arrow = $('<div/>').addClass('aqi-arrow');
  const $arrowWrapper = $('<div/>')
    .addClass('aqi-arrow-wrapper')
    .click(() => {
      $elem.addClass('aqi-hide-exception');
      $positioner.addClass('aqi-disabled');
    })
    .append($arrow);
  
  $contents.append($arrowWrapper);
  $positioner.append($contents);
  
  // Insert the notification into the DOM.
  if (putInside) {
    $elem.prepend($positioner);
  } else {
    $elem.before($positioner);
  }
}

/**
 * Assembles and returns a regular expression built from the stored blacklist.
 */
async function makeRegex(): Promise<RegExp> {
  try {
    const items = await GetOptions();
    const bannedWords = items.blacklist;
    return regexpFromWordList(Object.keys(bannedWords));
  } catch (err) {
    console.error(`Error generating regex: ${err}`);
    // Return a regex that matches nothing if an error occurs.
    return /a^/;
  }
}

/**
 * Processes a text node: if its content matches the regex, it applies
 * the appropriate classes and notifications to its feed-like ancestor.
 */
function processTextNode(node: CharacterData, hideCompletely: boolean, regex: RegExp): void {
  // Early return if the node's text does not match the regex.
  if (!regex.test(node.data)) {
    return;
  }
  
  // Skip nodes (or their parents) that are hidden.
  if ($(node).add($(node).parents()).filter(':hidden').length) {
    return;
  }
  
  // Get the feed-like ancestor for the node.
  const ancestor = getFeedlikeAncestor(node);
  try {
    if (hideCompletely) {
      ancestor.addClass('aqi-hide-completely');
    } else {
      const putInside = getCanonicalHostname(window.location.host) === 'youtube.com';
      addNotification(ancestor, putInside);
      ancestor.addClass('aqi-hide');
      if (putInside) {
        ancestor.addClass('aqi-put-inside-mode');
      }
    }
  } catch (e) {
    console.error('Error processing text node for notification:', e);
  }
}

// Global MutationObserver instance.
let observer: MutationObserver | null = null;
// Timeout ID for debouncing mutation processing.
let mutationTimeout: number | undefined;

/**
 * Starts observing DOM changes using MutationObserver with debouncing to
 * efficiently process text node changes.
 */
function startObservingChanges(processCallback: (node: CharacterData) => void): void {
  const targetNode = document.documentElement;
  const config: MutationObserverInit = {
    attributes: true,      // Monitor attribute changes.
    childList: true,       // Monitor addition/removal of nodes.
    characterData: true,   // Monitor changes to text nodes.
    subtree: true,         // Observe the entire document.
  };

  const observerCallback: MutationCallback = function (mutationsList: MutationRecord[]) {
    // Debounce processing to avoid handling rapid successive mutations.
    if (mutationTimeout !== undefined) {
      clearTimeout(mutationTimeout);
    }
    mutationTimeout = window.setTimeout(() => {
      mutationsList.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.target instanceof HTMLElement) {
          const walker = document.createTreeWalker(
            mutation.target,
            NodeFilter.SHOW_TEXT,
            null
          );
          while (walker.nextNode()) {
            if (walker.currentNode instanceof CharacterData) {
              processCallback(walker.currentNode);
            }
          }
        } else if (mutation.type === 'childList') {
          mutation.addedNodes.forEach((node) => {
            const walker = document.createTreeWalker(
              node,
              NodeFilter.SHOW_TEXT,
              null
            );
            while (walker.nextNode()) {
              if (walker.currentNode instanceof CharacterData) {
                processCallback(walker.currentNode);
              }
            }
          });
        } else if (mutation.type === 'characterData') {
          if (mutation.target instanceof CharacterData) {
            processCallback(mutation.target);
          }
        }
      });
    }, 100); // 100ms debounce delay.
  };

  if (observer) {
    observer.disconnect();
  }
  observer = new MutationObserver(observerCallback);
  observer.observe(targetNode, config);
}

/**
 * Clears all modifications and disconnects observers.
 */
function clearAll(): void {
  if (observer) {
    observer.disconnect();
  }
  $('.aqi-hide').removeClass('aqi-hide');
  $('.aqi-put-inside-mode').removeClass('aqi-put-inside-mode');
  $('.aqi-hide-completely').removeClass('aqi-hide-completely');
  $('.aqi-notification').remove();
  $('.aqi-debug').removeClass('aqi-debug');
}

/**
 * Renders the content modifications by processing text nodes and
 * starting the MutationObserver.
 */
function render(enabledEverywhere: boolean, hideCompletely: boolean, disableSite: boolean, regex: RegExp): void {
  clearAll();

  // If the extension is disabled globally or on this site, exit early.
  if (!enabledEverywhere || disableSite) {
    return;
  }

  // Function to process individual text nodes.
  const process = (node: CharacterData) => processTextNode(node, hideCompletely, regex);

  // Start watching for DOM changes.
  startObservingChanges(process);

  // Process existing text nodes in the document.
  const treeWalker = document.createTreeWalker(
    document.documentElement,
    NodeFilter.SHOW_TEXT,
    null
  );
  while (treeWalker.nextNode()) {
    if (treeWalker.currentNode instanceof CharacterData) {
      process(treeWalker.currentNode);
    }
  }
}

/**
 * Fetches all required options and re-renders the page modifications.
 */
async function restart(): Promise<void> {
  try {
    const items = await GetOptions();
    const enabledEverywhere = items.enabled;
    const hideCompletely = await fetchStatusForHost('hide_completely');
    const disableSite = await fetchStatusForHost('disable_site');
    const regex = await makeRegex();
    render(enabledEverywhere, hideCompletely, disableSite, regex);

    // Send a message to the background script with the count of hidden elements,
    // if not running in an iframe.
    if (my_id !== 'ignore' && !inIframe()) {
      const count = $('.aqi-hide, .aqi-hide-completely').length;
      chrome.runtime.sendMessage({ count });
    }
  } catch (err) {
    console.error('Error restarting content script:', err);
  }
}

// Listen for changes to chrome storage (e.g., blacklist updates) and restart.
chrome.storage.onChanged.addListener(restart);

// Initial execution.
restart();
