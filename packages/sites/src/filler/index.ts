import { visibleText, type VisibleText } from '../crawl/visible-text';
import { zeroCounters } from './counters';
import { demoMarkers } from './demo';
import { latinBlocks } from './latin';

export { latinBlocks, LATIN_VOCABULARY } from './latin';
export { demoMarkers } from './demo';
export { zeroCounters } from './counters';

export type FillerReason = 'latin_filler' | 'demo_markers' | 'zero_counter';

export interface FillerResult {
  filler: boolean;
  reasons: FillerReason[];
}

/**
 * D-18 / R3: a page is placeholder content when one block is Latin filler, or two distinct demo
 * markers appear, or one demo marker is corroborated by a zero counter without an animation
 * target. A zero counter alone never flags a page. Such a page yields no owner names.
 */
export function isFillerPage(page: { html: string; visible?: VisibleText }): FillerResult {
  const visible = page.visible ?? visibleText(page.html);
  const reasons: FillerReason[] = [];
  const latin = latinBlocks(visible.blocks).length > 0;
  const markers = demoMarkers(visible.text);
  const counters = zeroCounters(page.html);

  if (latin) reasons.push('latin_filler');
  if (markers.length >= 2 || (markers.length >= 1 && counters >= 1)) reasons.push('demo_markers');
  if (counters >= 1 && reasons.length > 0) reasons.push('zero_counter');
  return { filler: reasons.length > 0, reasons };
}
