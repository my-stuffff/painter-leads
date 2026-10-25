/** Demo-content markers left behind by themes (R3). Two distinct markers make a page placeholder content. */
export const DEMO_MARKERS: readonly { id: string; re: RegExp }[] = [
  { id: 'john-doe', re: /\bJohn Doe\b/i },
  { id: 'jane-doe', re: /\bJane Doe\b/i },
  { id: 'your-name', re: /\bYour Name\b/i },
  { id: 'team-member', re: /\bTeam Member\b/i },
  { id: 'lorem', re: /\bLorem\b/i },
  { id: 'sample-page', re: /\bSample Page\b/i },
  { id: 'hello-world', re: /\bHello world!/i },
  { id: 'just-another-wordpress-site', re: /\bJust another WordPress site\b/i },
  { id: '123-main-st', re: /\b123 Main St\b/i },
  { id: 'phone-555', re: /\(555\)/ },
  { id: 'phone-555-01nn', re: /\b555-01\d\d\b/ },
  { id: 'example-com', re: /\bexample\.com\b/i },
];

/** Distinct demo markers found in the text, in table order. */
export function demoMarkers(text: string): string[] {
  return DEMO_MARKERS.filter((m) => m.re.test(text)).map((m) => m.id);
}
