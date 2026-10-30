/*
 * Bare-metal firmware for the ARM MPS2 AN385 under QEMU.
 *
 *   UART1 RX : 12-byte pad frames from host/pad-reader.ps1  (50 Hz)
 *   UART0 TX : ARINC 429 words, 4 bytes little-endian each, 6 labels per tick
 *
 * Timebase: the Cortex-M3 SysTick counter, polled. No interrupts, no RTOS --
 * a superloop at 50 Hz is the whole scheduler, which is all this needs.
 */
#include <stdint.h>

#include "uart.h"
#include "a429.h"
#include "pad.h"
#include "flight.h"

/* SysTick (Cortex-M3 core peripheral). */
#define SYST_CSR (*(volatile uint32_t *)0xE000E010u)
#define SYST_RVR (*(volatile uint32_t *)0xE000E014u)
#define SYST_CVR (*(volatile uint32_t *)0xE000E018u)
#define SYST_CSR_ENABLE (1u << 0)
#define SYST_CSR_CLKSOURCE (1u << 2)

/* a429.h declares this; implemented here where uart_putc is in scope. */
void a429_send_word_impl(uint32_t base, uint32_t word) {
    uart_putc(base, (uint8_t)(word & 0xffu));
    uart_putc(base, (uint8_t)((word >> 8) & 0xffu));
    uart_putc(base, (uint8_t)((word >> 16) & 0xffu));
    uart_putc(base, (uint8_t)((word >> 24) & 0xffu));
}

/*
 * SysTick counts DOWN and wraps. A short reload period therefore hides elapsed
 * time whenever the superloop is slower than one reload -- measured: with a
 * 20 ms reload the firmware emitted 0.76 Hz instead of 50 Hz, because every
 * pass lost whole wraps. Running it free with the maximum reload makes a wrap
 * take 0.67 s at 25 MHz, far longer than any loop pass, so it is exact.
 *
 * elapsed = (last - now) + wraps * (RVR + 1)
 */
static uint32_t g_last_cvr = 0;
static uint32_t g_wraps = 0;

static inline void systick_elapsed_init(void) {
    g_last_cvr = SYST_CVR;
    g_wraps = 0;
}

static uint32_t systick_elapsed_ticks(void) {
    uint32_t now = SYST_CVR;
    if (now > g_last_cvr) g_wraps++; /* wrapped since the last read */
    uint32_t delta = (g_last_cvr - now) + g_wraps * (SYST_RVR + 1u);
    g_last_cvr = now;
    g_wraps = 0;
    return delta;
}

int main(void) {
    uart_init(UART0_BASE, 115200u);
    uart_init(UART1_BASE, 115200u);

    SYST_RVR = 0x00FFFFFFu; /* free-running: one wrap = 0.67 s at 25 MHz */
    SYST_CVR = 0u;
    SYST_CSR = SYST_CSR_CLKSOURCE | SYST_CSR_ENABLE;
    systick_elapsed_init();

    static flight_state_t fs;
    flight_init(&fs);

    static pad_state_t pad;
    pad.roll = 0.0f;
    pad.pitch = 0.0f;
    pad.cas = 120.0f / 250.0f;
    pad.vs = 0.0f;
    pad.buttons = 0;
    pad.pov = -1;
    pad.seq = 0;
    pad.got_frame = 0;

    /* Incoming UART1 byte assembly. */
    static uint8_t frame[PAD_FRAME_LEN];
    static int frame_len = 0;
    static uint32_t pad_frames_ok = 0;
    static uint32_t pad_frames_bad = 0;

    uart_puts(UART0_BASE, "FLIGHT-FW 1\n");

    uint32_t tick_accum = 0u;
    const uint32_t ticks_per_frame = SYSCLK_HZ / RATE_HZ;
    for (;;) {
        /* ---- drain UART1, byte by byte, resynchronising on A5 5A ---- */
        for (;;) {
            int c = uart_getc(UART1_BASE);
            if (c < 0) break;

            if (frame_len == 0 && (uint8_t)c != PAD_SYNC0) continue;
            if (frame_len == 1 && (uint8_t)c != PAD_SYNC1) {
                frame_len = (uint8_t)c == PAD_SYNC0 ? 1 : 0;
                continue;
            }
            frame[frame_len++] = (uint8_t)c;
            if (frame_len == PAD_FRAME_LEN) {
                if (pad_apply_frame(&pad, frame, frame_len)) {
                    pad_frames_ok++;
                } else {
                    pad_frames_bad++;
                    /* re-scan this frame's tail for a fresh sync */
                    frame_len = 0;
                    continue;
                }
                frame_len = 0;
            }
        }

        /* ---- 50 Hz tick, accumulated so no pass ever loses time ---- */
        tick_accum += systick_elapsed_ticks();
        if (tick_accum < ticks_per_frame) continue;
        tick_accum -= ticks_per_frame;

        if (!pad.got_frame) {
            /* No pad at all: keep the SFD alive on the modelled defaults. */
            pad.cas = fs.cas_kt / 250.0f;
            pad.vs = fs.vert_speed_fpm / 2000.0f;
        }

        flight_step(&fs, &pad);
        flight_transmit(&fs, UART0_BASE);
    }
}
