// src/network/erlang-term.js — Erlang's external term format (term_to_binary), which nodes answer
// with when a request does not ask for JSON. A browser cannot ask for JSON from
// /wallet_list: the content-type header it takes makes the request need CORS permission
// the node does not grant for that path. Only the types nodes send are read.

export class ErlangAtom {
  /** An Erlang atom (a named constant such as `true` or `last`), kept apart from strings. */
  constructor(name) {
    this.name = name;
  }
}

export class ErlangTuple {
  constructor(elements) {
    this.elements = elements;
  }
}

export class ErlangTerm {
  static VERSION = 131;

  /**
   * Decodes one term: binaries as Uint8Array, integers as BigInt, atoms as ErlangAtom,
   * tuples as ErlangTuple, lists as arrays, maps as Map (keys decoded the same way).
   */
  static decode(bytes) {
    if (bytes[0] !== ErlangTerm.VERSION) throw new Error(`not an Erlang term (first byte ${bytes[0]}, not 131)`);
    const reader = { bytes, view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset: 1 };
    const term = ErlangTerm.read(reader);
    if (reader.offset !== bytes.length) throw new Error(`${bytes.length - reader.offset} bytes left after the term`);
    return term;
  }

  static take(reader, count) {
    if (reader.offset + count > reader.bytes.length) throw new Error(`term ends early at byte ${reader.offset}`);
    const slice = reader.bytes.subarray(reader.offset, reader.offset + count);
    reader.offset += count;
    return slice;
  }

  static u8(reader) { return ErlangTerm.take(reader, 1)[0]; }
  static u16(reader) { const value = reader.view.getUint16(reader.offset); reader.offset += 2; return value; }
  static u32(reader) { const value = reader.view.getUint32(reader.offset); reader.offset += 4; return value; }

  /** A bignum: `count` little-endian bytes after a sign byte. */
  static big(reader, count) {
    const sign = ErlangTerm.u8(reader);
    let value = 0n;
    const digits = ErlangTerm.take(reader, count);
    for (let index = count - 1; index >= 0; index--) value = (value << 8n) | BigInt(digits[index]);
    return sign ? -value : value;
  }

  static read(reader) {
    const tag = ErlangTerm.u8(reader);
    switch (tag) {
      case 97: return BigInt(ErlangTerm.u8(reader)); // SMALL_INTEGER_EXT
      case 98: { const value = reader.view.getInt32(reader.offset); reader.offset += 4; return BigInt(value); } // INTEGER_EXT
      case 110: return ErlangTerm.big(reader, ErlangTerm.u8(reader)); // SMALL_BIG_EXT
      case 111: return ErlangTerm.big(reader, ErlangTerm.u32(reader)); // LARGE_BIG_EXT
      case 109: return ErlangTerm.take(reader, ErlangTerm.u32(reader)).slice(); // BINARY_EXT
      case 119: return new ErlangAtom(new TextDecoder().decode(ErlangTerm.take(reader, ErlangTerm.u8(reader)))); // SMALL_ATOM_UTF8_EXT
      case 118: return new ErlangAtom(new TextDecoder().decode(ErlangTerm.take(reader, ErlangTerm.u16(reader)))); // ATOM_UTF8_EXT
      case 115: return new ErlangAtom(new TextDecoder('latin1').decode(ErlangTerm.take(reader, ErlangTerm.u8(reader)))); // SMALL_ATOM_EXT
      case 100: return new ErlangAtom(new TextDecoder('latin1').decode(ErlangTerm.take(reader, ErlangTerm.u16(reader)))); // ATOM_EXT
      case 104: return ErlangTerm.tuple(reader, ErlangTerm.u8(reader)); // SMALL_TUPLE_EXT
      case 105: return ErlangTerm.tuple(reader, ErlangTerm.u32(reader)); // LARGE_TUPLE_EXT
      case 106: return []; // NIL_EXT
      case 107: return Array.from(ErlangTerm.take(reader, ErlangTerm.u16(reader)), (byte) => BigInt(byte)); // STRING_EXT: a list of bytes
      case 108: { // LIST_EXT: elements, then a tail (NIL for a proper list)
        const length = ErlangTerm.u32(reader);
        const list = Array.from({ length }, () => ErlangTerm.read(reader));
        const tail = ErlangTerm.read(reader);
        if (!(Array.isArray(tail) && tail.length === 0)) throw new Error('improper lists are not read');
        return list;
      }
      case 116: { // MAP_EXT
        const arity = ErlangTerm.u32(reader);
        const map = new Map();
        for (let index = 0; index < arity; index++) {
          const key = ErlangTerm.read(reader);
          map.set(key instanceof ErlangAtom ? key.name : key, ErlangTerm.read(reader));
        }
        return map;
      }
      default: throw new Error(`Erlang term tag ${tag} at byte ${reader.offset - 1} is not read here`);
    }
  }

  static tuple(reader, arity) {
    return new ErlangTuple(Array.from({ length: arity }, () => ErlangTerm.read(reader)));
  }
}
