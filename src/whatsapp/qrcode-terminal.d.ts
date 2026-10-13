declare module "qrcode-terminal" {
  interface QrCodeTerminal {
    generate(text: string, opts?: { small?: boolean }, cb?: (qr: string) => void): void;
    setErrorLevel(level: "L" | "M" | "Q" | "H"): void;
  }
  const qrcode: QrCodeTerminal;
  export default qrcode;
}
