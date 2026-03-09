// Silence console.warn and console.log during tests to reduce noise.
// console.error is left intact so real errors are visible.
global.console.warn = jest.fn();
global.console.log = jest.fn();
