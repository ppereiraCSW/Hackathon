/*
 * Flight-state model + ARINC 429 transmit schedule.
 *
 * The 6 parameters and how the pad drives them (decided 2026-10-30, because the
 * pad exposes only 4 axes):
 *
 *   X  (roll axis)   -> roll          -45 .. +45 deg
 *   Y  (pitch axis)  -> pitch         -20 .. +20 deg
 *   Z  (throttle)    -> CAS             0 .. 250 kt
 *   R  (rudder)      -> vertical speed -2000 .. +2000 ft/min
 *   derived          -> heading       integrated from roll as a coordinated turn
 *   derived          -> baro altitude integrated from vertical speed
 *
 * Buttons: A = reset pitch/roll trim, B = reset heading, LB/RB = CAS -/+10 kt,
 * D-pad up/down = altitude +/-500 ft, START = freeze (all labels -> NCD).
 */
#ifndef FLIGHT_H
#define FLIGHT_H

#include <stdint.h>
#include "pad.h"
#include "a429.h"
#include "uart.h"

/* Label definitions, mirroring shared/labels.json. Label values are OCTAL. */
#define LBL_PITCH      0324u /* 212 dec */
#define LBL_ROLL       0325u /* 213 dec */
#define LBL_HEADING    0314u /* 204 dec */
#define LBL_BARO_ALT   0204u /* 132 dec */
#define LBL_CAS        0206u /* 134 dec */
#define LBL_VERT_SPEED 0212u /* 138 dec */

#define LSB_ATTITUDE   (180.0f / 4096.0f)
#define LSB_HEADING    (180.0f / 4096.0f)
#define LSB_BARO_ALT   4.0f
#define LSB_CAS        0.125f
#define LSB_VERT_SPEED 1.0f

#define RATE_HZ 50u
#define DT_S    (1.0f / (float)RATE_HZ)

typedef struct {
    float pitch_deg;
    float roll_deg;
    float heading_deg;
    float baro_alt_ft;
    float cas_kt;
    float vert_speed_fpm;
    float pitch_trim_deg; /* stick-trim offset */
    float roll_trim_deg;
    uint8_t freeze;       /* 1 = report NCD on every label */
    uint32_t tick;
    uint32_t prev_buttons;
} flight_state_t;

static inline void flight_init(flight_state_t *s) {
    s->pitch_deg = 0.0f;
    s->roll_deg = 0.0f;
    s->heading_deg = 0.0f;
    s->baro_alt_ft = 5000.0f; /* start airborne, on a demo-friendly altitude */
    s->cas_kt = 120.0f;
    s->vert_speed_fpm = 0.0f;
    s->pitch_trim_deg = 0.0f;
    s->roll_trim_deg = 0.0f;
    s->freeze = 0;
    s->tick = 0;
    s->prev_buttons = 0;
}

static inline float wrap_360(float d) {
    while (d < 0.0f) d += 360.0f;
    while (d >= 360.0f) d -= 360.0f;
    return d;
}

/* One 50 Hz step: consume pad state, integrate derived values, apply buttons. */
#define BTN_A_RESET_TRIM 0x0001u
#define BTN_B_RESET_HDG  0x0002u
#define BTN_LB_CAS_DOWN  0x0004u
#define BTN_RB_CAS_UP    0x0008u
#define BTN_START_FREEZE 0x0010u
#define POV_UP           0
#define POV_DOWN         18000

static inline void flight_step(flight_state_t *s, const pad_state_t *pad) {
    s->tick++;

    /* --- direct axes --- */
    if (!s->freeze) {
        s->roll_deg = pad->roll * 45.0f + s->roll_trim_deg;
        s->pitch_deg = pad->pitch * 20.0f + s->pitch_trim_deg;
        s->cas_kt = pad->cas * 250.0f;
        s->vert_speed_fpm = pad->vs * 2000.0f;
    }


    /* --- derived: heading, coordinated turn ---
     * A standard-rate turn is 3 deg/s at 30 deg bank, so rate ~= 3 * tan(roll)/tan(30).
     * Clamped to keep the demo stable at extreme bank. */
    float roll_rad = s->roll_deg * 3.14159265358979f / 180.0f;
    float t = roll_rad;
    /* tan via a short series is enough for |roll| <= 45 deg */
    float tan_roll = t + (t * t * t) / 3.0f;
    float turn_rate = 3.0f * tan_roll / 0.5773502692f; /* tan(30 deg) */
    if (turn_rate > 25.0f) turn_rate = 25.0f;
    if (turn_rate < -25.0f) turn_rate = -25.0f;
    s->heading_deg = wrap_360(s->heading_deg + turn_rate * DT_S);

    /* --- derived: altitude integrates vertical speed --- */
    s->baro_alt_ft += (s->vert_speed_fpm / 60.0f) * DT_S;
    if (s->baro_alt_ft < -1000.0f) s->baro_alt_ft = -1000.0f;
    if (s->baro_alt_ft > 100000.0f) s->baro_alt_ft = 100000.0f;

    /* --- buttons (edge-triggered) --- */
    uint16_t prev = s->prev_buttons;
    uint16_t pressed = (uint16_t)(pad->buttons & ~prev);
    s->prev_buttons = pad->buttons;

    if (pressed & BTN_A_RESET_TRIM) {
        s->pitch_trim_deg = 0.0f;
        s->roll_trim_deg = 0.0f;
    }
    if (pressed & BTN_B_RESET_HDG) {
        s->heading_deg = 0.0f;
    }
    if (pressed & BTN_LB_CAS_DOWN) {
        s->cas_kt -= 10.0f;
        if (s->cas_kt < 0.0f) s->cas_kt = 0.0f;
    }
    if (pressed & BTN_RB_CAS_UP) {
        s->cas_kt += 10.0f;
        if (s->cas_kt > 250.0f) s->cas_kt = 250.0f;
    }
    if (pressed & BTN_START_FREEZE) {
        s->freeze = !s->freeze;
    }
    if (pad->pov == POV_UP) {
        s->baro_alt_ft += 500.0f;
        if (s->baro_alt_ft > 100000.0f) s->baro_alt_ft = 100000.0f;
    } else if (pad->pov == POV_DOWN) {
        s->baro_alt_ft -= 500.0f;
        if (s->baro_alt_ft < -1000.0f) s->baro_alt_ft = -1000.0f;
    }
}

/* Transmit all six labels once, one word each, in a fixed order. */
static inline void flight_transmit(const flight_state_t *s, uint32_t base) {
    struct {
        uint16_t label;
        float value;
        float lsb;
        float vmin;
        float vmax;
    } defs[6] = {
        {LBL_PITCH, s->pitch_deg, LSB_ATTITUDE, -180.0f, 180.0f},
        {LBL_ROLL, s->roll_deg, LSB_ATTITUDE, -180.0f, 180.0f},
        {LBL_HEADING, wrap_360(s->heading_deg), LSB_HEADING, 0.0f, 360.0f},
        {LBL_BARO_ALT, s->baro_alt_ft, LSB_BARO_ALT, -1000.0f, 100000.0f},
        {LBL_CAS, s->cas_kt, LSB_CAS, 0.0f, 600.0f},
        {LBL_VERT_SPEED, s->vert_speed_fpm, LSB_VERT_SPEED, -32000.0f, 32000.0f},
    };

    for (int i = 0; i < 6; i++) {
        uint32_t mag = 0;
        uint8_t ssm = A429_SSM_PLUS;

        if (s->freeze) {
            /* Deliberate NCD on every label: one button demonstrates the whole
             * validity path, firmware -> A429 -> backend -> SFD annunciation. */
            ssm = A429_SSM_NCD;
        } else {
            a429_encode_value(defs[i].value, defs[i].lsb, defs[i].vmin, defs[i].vmax, &mag, &ssm);
        }

        a429_send_word(base, a429_encode(defs[i].label, 0u, mag, ssm));
    }
}

#endif /* FLIGHT_H */
