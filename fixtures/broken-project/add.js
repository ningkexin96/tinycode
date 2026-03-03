// Intentionally buggy: add() subtracts instead of adding.
// The harness E2E test uses the edit tool to fix this.
export function add(a, b) {
  return a - b;
}
