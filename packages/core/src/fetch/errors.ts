export class RobotsDisallowedError extends Error {
  constructor(message = 'robots.txt disallows this URL') {
    super(message);
    this.name = 'RobotsDisallowedError';
  }
}

export class SsrfRefusedError extends Error {
  constructor(message = 'target address is not a public internet address') {
    super(message);
    this.name = 'SsrfRefusedError';
  }
}

export class OfflineCacheMissError extends Error {
  constructor(message = 'offline mode: page is not in the cache') {
    super(message);
    this.name = 'OfflineCacheMissError';
  }
}

export class BodyTooLargeError extends Error {
  constructor(message = 'response body exceeds the configured limit') {
    super(message);
    this.name = 'BodyTooLargeError';
  }
}

export class SourceDisabledError extends Error {
  constructor(message = 'source is switched off in pp.config.json') {
    super(message);
    this.name = 'SourceDisabledError';
  }
}

export class NetworkDisabledError extends Error {
  constructor(message = 'network access is disabled (tests fail closed)') {
    super(message);
    this.name = 'NetworkDisabledError';
  }
}
