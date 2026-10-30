/*
 * Linker script for ARM MPS2 AN385 in QEMU.
 *   code  : 0x00000000, 4 MiB
 *   RAM   : 0x20000000, 4 MiB
 */
MEMORY
{
    CODE (rx)  : ORIGIN = 0x00000000, LENGTH = 4M
    RAM  (rwx) : ORIGIN = 0x20000000, LENGTH = 4M
}

ENTRY(Reset_Handler)

_estack = ORIGIN(RAM) + LENGTH(RAM);

SECTIONS
{
    .isr_vector : {
        KEEP(*(.isr_vector))
    } > CODE

    .text : {
        *(.text*)
        *(.rodata*)
    } > CODE

    _sidata = LOADADDR(.data);

    .data : {
        _sdata = .;
        *(.data*)
        _edata = .;
    } > RAM AT > CODE

    .bss : {
        _sbss = .;
        *(.bss*)
        *(COMMON)
        _ebss = .;
    } > RAM

    /DISCARD/ : { *(.ARM.exidx*) *(.comment) }
}
