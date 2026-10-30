/*
 * CMSDK APB UART driver for the ARM MPS2 AN385 board, as emulated by QEMU.
 *
 * Register map (CMSDK APB UART, from the MPS2 AN385 technical reference):
 *   0x000 DATA     write = transmit, read = receive (low 8 bits)
 *   0x004 STATE    bit0 TX buffer full, bit1 RX buffer full
 *   0x008 CTRL     bit0 TX enable, bit1 RX enable
 *   0x00C INTSTATUS
 *   0x010 BAUDDIV  peripheral clock / baud rate
 */
#ifndef UART_H
#define UART_H

#include <stdint.h>

#define UART0_BASE 0x40004000u   /* -> backend (A429 words out) */
#define UART1_BASE 0x40005000u   /* <- host pad reader            */

#define UART_DATA(base)  (*(volatile uint32_t *)((base) + 0x00u))
#define UART_STATE(base) (*(volatile uint32_t *)((base) + 0x04u))
#define UART_CTRL(base)  (*(volatile uint32_t *)((base) + 0x08u))
#define UART_BAUD(base)  (*(volatile uint32_t *)((base) + 0x10u))

#define UART_STATE_TXFULL (1u << 0)
#define UART_STATE_RXFULL (1u << 1)

/* MPS2 AN385 system clock in QEMU is 25 MHz. */
#define SYSCLK_HZ 25000000u

static inline void uart_init(uint32_t base, uint32_t baud) {
    UART_BAUD(base) = (baud && baud < SYSCLK_HZ) ? (SYSCLK_HZ / baud) : 216u;
    UART_CTRL(base) = 0x3u; /* TX + RX enable */
}

static inline void uart_putc(uint32_t base, uint8_t c) {
    while (UART_STATE(base) & UART_STATE_TXFULL) {
    }
    UART_DATA(base) = (uint32_t)c;
}

/* Non-blocking: returns -1 when nothing is waiting. */
static inline int uart_getc(uint32_t base) {
    if (!(UART_STATE(base) & UART_STATE_RXFULL)) return -1;
    return (int)(UART_DATA(base) & 0xffu);
}

static inline void uart_puts(uint32_t base, const char *s) {
    while (*s) uart_putc(base, (uint8_t)*s++);
}

#endif /* UART_H */
