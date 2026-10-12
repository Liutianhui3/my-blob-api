// Multipart parsers can interpret browser UTF-8 filename bytes as Latin-1.
// Decode only when the entire Latin-1 byte sequence is valid UTF-8; preserve
// already-decoded Unicode and genuine Latin-1 names when decoding is invalid.
export function decodeFilename(name: string): string {
  if (Array.from(name).some((character) => character.codePointAt(0)! > 255))
    return name;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.from(name, 'latin1'),
    );
  } catch {
    return name;
  }
}
