export function byId(id) {
  return document.getElementById(id);
}

export function show(element) {
  element.classList.remove("hidden");
}

export function hide(element) {
  element.classList.add("hidden");
}

export function setText(element, text) {
  element.textContent = text;
}

export function clear(element) {
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
}

export function create(tagName, options = {}, children = []) {
  const element = document.createElement(tagName);
  const { className, text, attrs, on } = options;

  if (className) element.className = className;
  if (text != null) element.textContent = text;
  if (attrs) {
    for (const [name, value] of Object.entries(attrs)) {
      element.setAttribute(name, value);
    }
  }
  if (on) {
    for (const [eventName, handler] of Object.entries(on)) {
      element.addEventListener(eventName, handler);
    }
  }
  for (const child of children) {
    element.append(child);
  }
  return element;
}

export function formatNumber(value) {
  return Number(value).toLocaleString();
}
