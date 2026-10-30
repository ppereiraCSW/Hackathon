/*
 * Bring-up smoke test: emit a known string on UART0 and keep running.
 * Its only job is to prove the MPS2 AN385 UART mapping works under QEMU
 * before any ARINC 429 logic depends on it.
 */
#include <stdint.h>
#include "uart.h"

extern void a429_send_word_impl(uint32_t base, uint32_t word);

void a429_send_word_impl(uint32_t base, uint32_t word) {
    uart_putc(base, (uint8_t)(word & 0xffu));
    uart_putc(base, (uint8_t)((word >> 8) & 0xffu));
    uart_putc(base, (uint8_t)((word >> 16) & 0xffu));
    uart_putc(base, (uint8_t)((word >> 24) & 0xffu));
}

int main(void) {
    uart_init(UART0_BASE, 115200u);
    uart_init(UART1_BASE, 115200u);
    uart_puts(UART0_BASE, "MPS2-AN385 BOOT OK\n");

    /* Emit the first golden vector as 4 little-endian bytes: 0x8000002B. */
    a429_send_word_impl(UART0_BASE, 0x8000002Bu);

    for (;;) {
    }
}
