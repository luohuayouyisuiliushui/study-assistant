import '@testing-library/jest-dom/vitest';

// Mock IntersectionObserver for jsdom
global.IntersectionObserver = class IntersectionObserver {
  constructor() {}
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mock matchMedia
global.matchMedia = () => ({ matches: false, addListener: () => {}, removeListener: () => {} });

// Mock scrollTo
Element.prototype.scrollTo = () => {};
Element.prototype.scrollIntoView = () => {};

// Mock SpeechRecognition
global.SpeechRecognition = undefined;
global.webkitSpeechRecognition = undefined;
