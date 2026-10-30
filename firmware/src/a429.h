/*
 * ARINC 429 word encoder -- bare-metal C mirror of backend/src/a429/codec.js.
 *
 * The two implementations must produce identical bytes; that equality is what
 * tools/qemu.mjs --vectors proves against shared/a429-vectors.json.
 */
#ifndef A429_H
#define A429_H

#include <stdint.h>

#define A429_SSM_PLUS  0u
#define A429_SSM_NCD   1u
#define A429_SSM_TEST  2u
#define A429_SSM_MINUS 3u

#define A429_DATA_MAX 0x7FFFFu /* 19 bits */

static inline uint8_t a429_reverse_byte(uint8_t b) {
    uint8_t r = 0;
    for (int i = 0; i < 8; i++) {
        if ((b >> i) & 1u) r |= (uint8_t)(1u << (7 - i));
    }
    return r;
}

/* Odd parity over the low 31 bits. */
static inline uint32_t a429_parity_bit(uint32_t w31) {
    uint32_t ones = 0;
    for (int i = 0; i < 31; i++) ones += (w31 >> i) & 1u;
    return (ones % 2u == 0u) ? 1u : 0u;
}

/**
 * Encode one word.
 * @param label_oct octal label value, e.g. 0324
 * @param sdi       0..3
 * @param magnitude BNR magnitude, 0..0x7FFFF
 * @param ssm       A429_SSM_*
 */
static inline uint32_t a429_encode(uint16_t label_oct, uint8_t sdi, uint32_t magnitude, uint8_t ssm) {
    if (magnitude > A429_DATA_MAX) magnitude = A429_DATA_MAX;
    uint32_t w = 0;
    w |= (uint32_t)a429_reverse_byte((uint8_t)(label_oct & 0xffu));
    w |= ((uint32_t)(sdi & 0x3u)) << 8;
    w |= (magnitude & A429_DATA_MAX) << 10;
    w |= ((uint32_t)(ssm & 0x3u)) << 29;
    w |= a429_parity_bit(w) << 31;
    return w;
}

/* Engineering value -> magnitude + SSM, mirroring encodeValue() in codec.js. */
static inline void a429_encode_value(float value, float lsb, float vmin, float vmax,
                                     uint32_t *magnitude, uint8_t *ssm) {
    if (value < vmin) value = vmin;
    if (value > vmax) value = vmax;
    float mag = (value < 0.0f ? -value : value) / lsb;
    uint32_t m = (uint32_t)(mag + 0.5f);
    if (m > A429_DATA_MAX) m = A429_DATA_MAX;
    *magnitude = m;
    *ssm = (value < 0.0f) ? A429_SSM_MINUS : A429_SSM_PLUS;
}

/* One word = 4 bytes, little-endian, exactly as backend/src/a429/codec.js packs it. */
static inline void a429_send_word(uint32_t base, uint32_t word) {
    /* uart_putc is declared in uart.h; included by the caller. */
    extern void a429_send_word_impl(uint32_t base, uint32_t word);
    a429_send_word_impl(base, word);
}

#endif /* A429_H */
