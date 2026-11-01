import { performance } from 'node:perf_hooks';
import { createEnvironment } from '../src/runtime/index.mjs';

const { document } = createEnvironment();
const element = document.createElement('div');
element.setAttribute('style', 'left: 0; margin: 0 2px; opacity: 0; --offset: 0; color: red');
const style = element.style;
const iterations = 100000;
const samples = 5;

function medianMilliseconds(read) {
  for (let i = 0; i < 10000; i++) read();
  const durations = [];
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) read();
    durations.push(performance.now() - start);
  }
  return durations.sort((a, b) => a - b)[Math.floor(samples / 2)];
}

console.log(JSON.stringify({
  iterations, samples,
  median_ms: {
    cssText: medianMilliseconds(() => style.cssText),
    property: medianMilliseconds(() => style.left),
  },
}));
