/*
 * Flight-state model + ARINC 429 transmit schedule.
 *
 * The 6 parameters and how the pad drives them (decided 2026-10-30, because the
 * pad exposes only 4 axes):
 *
 * The axes are RATE commands: stick deflection sets how fast a value changes,
 * and centring the stick holds it (decided 2026-10-30; the first version mapped
 * stick position straight to value, so everything snapped back on release and
 * heading only wobbled around 0/359).
 *
 *   X  (roll axis)   -> roll rate       up to 30 deg/s,  roll  -45 .. +45 deg
 *   Y  (pitch axis)  -> pitch rate      up to 10 deg/s,  pitch -20 .. +20 deg
 *   Z  (throttle)    -> CAS rate        up to 25 kt/s,   CAS     0 .. 250 kt
 *   derived          -> heading       integrated from roll as a coordinated turn
 *   derived          -> vertical speed  from pitch and airspeed (CAS * sin(pitch))
 *   derived          -> baro altitude integrated from vertical speed
 *
 * The R axis is still carried in the pad frame but no longer drives anything:
 * V/S used to be its own axis, so pitching up moved the attitude indicator
 * while altitude stayed put (changed 2026-10-30). Now attitude, V/S and
 * altitude always agree: nose up climbs, nose down descends, faster climbs
 * faster at the same pitch.
 *
 * Buttons: A = wings level (roll and pitch to 0), B held 1 s = reset heading,
 * LB/RB = CAS -/+10 kt, D-pad up/down = altitude +/-500 ft per press,
 * START = freeze (all labels -> NCD).
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

/* Full-deflection rates and the limits each value is held within. */
#define ROLL_RATE_DPS   30.0f
#define PITCH_RATE_DPS  10.0f
#define CAS_RATE_KTS    25.0f
#define ROLL_LIMIT_DEG  45.0f
#define PITCH_LIMIT_DEG 20.0f
#define CAS_MAX_KT      250.0f
#define VS_LIMIT_FPM    6000.0f
/* The ground is sea level. The altitude label can carry down to -1000 ft (for
 * below-sea-level airfields), but the model used that as its floor, so a dive
 * parked the aircraft at -1000 ft while still reporting a descent. */
#define ALT_GROUND_FT   0.0f
#define ALT_CEILING_FT  100000.0f
#define FPM_PER_KT      101.2686f /* 1 kt = 6076.12 ft/h = 101.27 ft/min */

static inline float clampf(float v, float lo, float hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

typedef struct {
    float pitch_deg;
    float roll_deg;
    float heading_deg;
    float baro_alt_ft;
    float cas_kt;
    float vert_speed_fpm;
    uint16_t hdg_reset_ticks; /* consecutive ticks B has been held */
    uint8_t freeze;       /* 1 = report NCD on every label */
    uint32_t tick;
    uint32_t prev_buttons;
    int16_t prev_pov;
} flight_state_t;

static inline void flight_init(flight_state_t *s) {
    s->pitch_deg = 0.0f;
    s->roll_deg = 0.0f;
    s->heading_deg = 0.0f;
    s->baro_alt_ft = 5000.0f; /* start airborne, on a demo-friendly altitude */
    s->cas_kt = 120.0f;
    s->vert_speed_fpm = 0.0f;
    s->hdg_reset_ticks = 0;
    s->freeze = 0;
    s->tick = 0;
    s->prev_buttons = 0;
    s->prev_pov = -1;
}

static inline float wrap_360(float d) {
    while (d < 0.0f) d += 360.0f;
    while (d >= 360.0f) d -= 360.0f;
    return d;
}

/* One 50 Hz step: consume pad state, integrate derived values, apply buttons. */
#define BTN_A_LEVEL      0x0001u
#define BTN_B_RESET_HDG  0x0002u
/* Heading reset is destructive, so it needs a deliberate 1 s hold. On the demo
 * pad B was found firing by itself at ~5 Hz (turbo/auto-fire), and with an
 * edge trigger every pulse zeroed the heading, pinning the SFD at 000. */
#define HDG_RESET_HOLD_TICKS RATE_HZ
#define BTN_LB_CAS_DOWN  0x0004u
#define BTN_RB_CAS_UP    0x0008u
#define BTN_START_FREEZE 0x0010u
#define POV_UP           0
#define POV_DOWN         18000

static inline void flight_step(flight_state_t *s, const pad_state_t *pad) {
    s->tick++;

    /* --- rate-commanded axes: deflection = rate, centred stick = hold --- */
    if (!s->freeze) {
        s->roll_deg = clampf(s->roll_deg + pad->roll * ROLL_RATE_DPS * DT_S,
                             -ROLL_LIMIT_DEG, ROLL_LIMIT_DEG);
        s->pitch_deg = clampf(s->pitch_deg + pad->pitch * PITCH_RATE_DPS * DT_S,
                              -PITCH_LIMIT_DEG, PITCH_LIMIT_DEG);
        s->cas_kt = clampf(s->cas_kt + pad->cas * CAS_RATE_KTS * DT_S, 0.0f, CAS_MAX_KT);
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

    /* --- derived: vertical speed = airspeed along the pitch angle ---
     * sin via a short series is enough for |pitch| <= 20 deg. */
    float p = s->pitch_deg * 3.14159265358979f / 180.0f;
    float sin_pitch = p - (p * p * p) / 6.0f;
    s->vert_speed_fpm = clampf(s->cas_kt * FPM_PER_KT * sin_pitch, -VS_LIMIT_FPM, VS_LIMIT_FPM);

    /* --- derived: altitude integrates vertical speed ---
     * Held at the ground or the ceiling, the aircraft is not moving vertically,
     * so V/S reads 0 there: V/S and altitude must never disagree. */
    s->baro_alt_ft += (s->vert_speed_fpm / 60.0f) * DT_S;
    if (s->baro_alt_ft <= ALT_GROUND_FT) {
        s->baro_alt_ft = ALT_GROUND_FT;
        if (s->vert_speed_fpm < 0.0f) s->vert_speed_fpm = 0.0f;
    }
    if (s->baro_alt_ft >= ALT_CEILING_FT) {
        s->baro_alt_ft = ALT_CEILING_FT;
        if (s->vert_speed_fpm > 0.0f) s->vert_speed_fpm = 0.0f;
    }

    /* --- buttons (edge-triggered) --- */
    uint16_t prev = s->prev_buttons;
    uint16_t pressed = (uint16_t)(pad->buttons & ~prev);
    s->prev_buttons = pad->buttons;

    if (pressed & BTN_A_LEVEL) {
        s->pitch_deg = 0.0f;
        s->roll_deg = 0.0f;
    }
    if (pad->buttons & BTN_B_RESET_HDG) {
        /* Fire once when the hold reaches 1 s, not again until released. */
        if (s->hdg_reset_ticks < HDG_RESET_HOLD_TICKS) {
            if (++s->hdg_reset_ticks == HDG_RESET_HOLD_TICKS) s->heading_deg = 0.0f;
        }
    } else {
        s->hdg_reset_ticks = 0;
    }
    if (pressed & BTN_LB_CAS_DOWN) {
        s->cas_kt = clampf(s->cas_kt - 10.0f, 0.0f, CAS_MAX_KT);
    }
    if (pressed & BTN_RB_CAS_UP) {
        s->cas_kt = clampf(s->cas_kt + 10.0f, 0.0f, CAS_MAX_KT);
    }
    if (pressed & BTN_START_FREEZE) {
        s->freeze = !s->freeze;
    }
    /* D-pad steps once per press; level-triggered it added 500 ft every tick. */
    int16_t pov_pressed = pad->pov != s->prev_pov ? pad->pov : -1;
    s->prev_pov = pad->pov;
    if (pov_pressed == POV_UP) {
        s->baro_alt_ft = clampf(s->baro_alt_ft + 500.0f, ALT_GROUND_FT, ALT_CEILING_FT);
    } else if (pov_pressed == POV_DOWN) {
        s->baro_alt_ft = clampf(s->baro_alt_ft - 500.0f, ALT_GROUND_FT, ALT_CEILING_FT);
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
