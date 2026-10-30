/*
 * Pad frame parsing: the host reader -> guest UART1 protocol.
 *
 * Frame (17 bytes, little-endian):
 *   A5 5A | seq:u16 | X Y Z R : u16 x4 | buttons:u16 | pov:i16 | xor:u8
 * The XOR covers every preceding byte.
 *
 * Axes arrive in WinMM's 0..65535 range with 32767 at centre; they are
 * normalised here to -1.0 .. +1.0 with a deadzone.
 */
#ifndef PAD_H
#define PAD_H

#include <stdint.h>

#define PAD_FRAME_LEN 17
#define PAD_SYNC0 0xA5
#define PAD_SYNC1 0x5A
#define PAD_AXIS_CENTRE 32767.0f
#define PAD_DEADZONE 0.06f

typedef struct {
    /* All axes are -1..+1 rate commands, 0 at centre (see flight.h). */
    float roll;      /* from X */
    float pitch;     /* from Y (stick back / pulled = +) */
    float cas;       /* from Z */
    float vs;        /* from R; parsed but unused, V/S follows pitch (flight.h) */
    uint16_t buttons;
    int16_t pov;     /* degrees * 100, or -1 for centred */
    uint16_t seq;
    uint8_t got_frame; /* 1 once a valid frame has ever been parsed */
} pad_state_t;

/* Button bit masks as the host reader reports them (WinMM order). */
#define BTN_BASE  0x0001u /* A */
#define BTN_RB    0x0002u /* B */
#define BTN_LB    0x0004u /* LB */
#define BTN_RT    0x0008u /* RB in WinMM numbering, see host/README */
#define BTN_START 0x0010u

static inline float pad_axis_norm(uint16_t raw) {
    float v = ((float)raw - PAD_AXIS_CENTRE) / PAD_AXIS_CENTRE;
    if (v > 1.0f) v = 1.0f;
    if (v < -1.0f) v = -1.0f;
    /* deadzone with rescale so the full travel stays usable */
    float a = v < 0.0f ? -v : v;
    if (a < PAD_DEADZONE) return 0.0f;
    float sign = v < 0.0f ? -1.0f : 1.0f;
    return sign * ((a - PAD_DEADZONE) / (1.0f - PAD_DEADZONE));
}

static inline uint16_t rd_u16(const uint8_t *p) {
    return (uint16_t)(p[0] | (p[1] << 8));
}

/**
 * Validate and apply one candidate frame.
 * @return 1 if the frame was valid and applied, 0 otherwise.
 */
static inline int pad_apply_frame(pad_state_t *st, const uint8_t *f, int len) {
    if (len < PAD_FRAME_LEN) return 0;
    if (f[0] != PAD_SYNC0 || f[1] != PAD_SYNC1) return 0;
    uint8_t x = 0;
    for (int i = 0; i < PAD_FRAME_LEN - 1; i++) x ^= f[i];
    if (x != f[PAD_FRAME_LEN - 1]) return 0;

    st->seq = rd_u16(f + 2);
    st->roll = pad_axis_norm(rd_u16(f + 4));
    st->pitch = pad_axis_norm(rd_u16(f + 6));
    st->cas = pad_axis_norm(rd_u16(f + 8));
    st->vs = pad_axis_norm(rd_u16(f + 10));
    st->buttons = rd_u16(f + 12);
    st->pov = (int16_t)rd_u16(f + 14);
    st->got_frame = 1;
    return 1;
}

#endif /* PAD_H */
