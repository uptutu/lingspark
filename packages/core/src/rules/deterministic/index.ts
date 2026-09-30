// Importing these modules registers their implementations. The rule YAML
// refers to them by the name passed to registerDeterministic.
import './numeric.js';
import './structure.js';
import './terminology.js';
import './text.js';

export { collectMeasurements, normalizeLabel, statedLabel } from './numeric.js';
export { parseNumeral } from './numerals.js';
