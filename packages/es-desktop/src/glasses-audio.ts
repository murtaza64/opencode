export const GLASSES_TRANSCRIBE = "/__es/voice/glasses"
export const LC3_TYPE = "application/x-g2-lc3"

// Run ctypes out of process so Electron needs no native Node addon. G2 sends five 10 ms frames
// per packet, followed by five trailer bytes; the last is a wrapping packet counter.
export const LC3_BYTES = 205
export const decodeLC3 = String.raw`
import ctypes as c
import sys
import wave

lib = c.CDLL('/opt/homebrew/lib/liblc3.dylib')
lib.lc3_decoder_size.argtypes = [c.c_int, c.c_int]
lib.lc3_decoder_size.restype = c.c_uint
lib.lc3_setup_decoder.argtypes = [c.c_int, c.c_int, c.c_int, c.c_void_p]
lib.lc3_setup_decoder.restype = c.c_void_p
lib.lc3_decode.argtypes = [c.c_void_p, c.c_void_p, c.c_int, c.c_int, c.c_void_p, c.c_int]
lib.lc3_decode.restype = c.c_int

with open(sys.argv[1], 'rb') as source:
    data = source.read()
if not data or len(data) % 205:
    sys.exit('Incomplete G2 audio')
memory = c.create_string_buffer(lib.lc3_decoder_size(10000, 16000))
decoder = lib.lc3_setup_decoder(10000, 16000, 0, memory)
if not decoder:
    sys.exit('Could not initialize G2 audio decoder')
pcm = (c.c_int16 * 160)()

def frame(wav, payload):
    buf = c.create_string_buffer(payload, 40) if payload else None
    if lib.lc3_decode(decoder, buf, 40 if payload else 0, 0, pcm, 1) < 0:
        sys.exit('Could not decode G2 audio')
    wav.writeframesraw(bytes(pcm))

with wave.open(sys.argv[2], 'wb') as wav:
    wav.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
    last = None
    for offset in range(0, len(data), 205):
        packet = data[offset:offset + 205]
        counter = packet[204]
        if last is not None:
            gap = (counter - last) & 255
            if gap == 0:
                continue
            if 1 < gap <= 9:
                for _ in range((gap - 1) * 5):
                    frame(wav, None)
        last = counter
        for start in range(0, 200, 40):
            frame(wav, packet[start:start + 40])
`
