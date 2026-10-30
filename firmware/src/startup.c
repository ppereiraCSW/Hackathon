/*
 * Startup code for the ARM MPS2 AN385 (Cortex-M3), QEMU.
 *
 * Vector table is placed at 0x00000000, which is where QEMU starts the core.
 * Only the first 16 system exceptions are needed; no peripheral interrupts are
 * used (SysTick is polled).
 */
#include <stdint.h>

extern uint32_t _estack;
extern uint32_t _sidata, _sdata, _edata, _sbss, _ebss;
extern int main(void);

void Reset_Handler(void);
void Default_Handler(void);

__attribute__((section(".isr_vector"), used))
void (*const g_vectors[])(void) = {
    (void (*)(void))&_estack, /* initial stack pointer */
    Reset_Handler,
    Default_Handler, /* NMI */
    Default_Handler, /* HardFault */
    Default_Handler, /* MemManage */
    Default_Handler, /* BusFault */
    Default_Handler, /* UsageFault */
    0, 0, 0, 0,
    Default_Handler, /* SVCall */
    Default_Handler, /* DebugMonitor */
    0,
    Default_Handler, /* PendSV */
    Default_Handler, /* SysTick */
};

void Reset_Handler(void) {
    /* copy .data from flash to RAM */
    uint32_t *src = &_sidata;
    for (uint32_t *dst = &_sdata; dst < &_edata;) *dst++ = *src++;
    /* zero .bss */
    for (uint32_t *dst = &_sbss; dst < &_ebss;) *dst++ = 0u;

    main();
    for (;;) {
    }
}

void Default_Handler(void) {
    /* Stay put and keep the stack intact; the run script notices silence. */
    for (;;) {
    }
}
