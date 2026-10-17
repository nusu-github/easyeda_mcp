export class BridgeUnavailableError extends Error {
  constructor(message = "EasyEDA Pro extension is not connected. Open EasyEDA Pro, install the extension, and enable external interaction permission.") {
    super(message);
    this.name = "BridgeUnavailableError";
  }
}

export class BridgeProtocolCompatibilityError extends Error {
  readonly expectedProtocolVersion: string;
  readonly actualProtocolVersion?: string;

  constructor(message: string, expectedProtocolVersion: string, actualProtocolVersion?: string) {
    super(message);
    this.name = "BridgeProtocolCompatibilityError";
    this.expectedProtocolVersion = expectedProtocolVersion;
    this.actualProtocolVersion = actualProtocolVersion;
  }
}

export class BridgeRpcError extends Error {
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, code?: string, details?: unknown) {
    super(message);
    this.name = "BridgeRpcError";
    this.code = code;
    this.details = details;
  }
}

export class BridgeTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`Timed out waiting ${timeoutMs}ms for EasyEDA Pro extension method "${method}".`);
    this.name = "BridgeTimeoutError";
  }
}

export class BridgeControlError extends Error {
  readonly method: string;
  readonly holder: string;

  constructor(method: string, holder: string) {
    super(`"${method}" needs the EasyEDA control right, which ${holder} holds. Call easyeda_control with action "take" to take it over.`);
    this.name = "BridgeControlError";
    this.method = method;
    this.holder = holder;
  }
}
