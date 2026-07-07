#pragma once

#include <Arduino.h>
#include "config.h"

// CoreXY forward/inverse kinematics, parameterized by the belt layout chosen
// in config.h (COREXY_LAYOUT). Same electronics as stock Blot, but the belt
// routing on this custom plotter can differ, which only changes the SIGNS in
// the motor-mixing matrix — never the structure. Everything else in the
// firmware (planner, stepper, junction deviation) is layout-agnostic because
// it works through these three functions.
//
// Inverse (Cartesian → motor-space mm):
//     a = COREXY_M1_X * x + COREXY_M1_Y * y
//     b = COREXY_M2_X * x + COREXY_M2_Y * y
// Forward (motor-space mm → Cartesian mm) is the exact matrix inverse of the
// above; it's derived here instead of hardcoded so any of the four layouts
// round-trips correctly with no per-layout edits.
//
// Both motors use the same steps/mm, so conversion to steps is just
// multiplication by STEPS_PER_MM.
//
// motor_load_for_unit_dir() returns max(|a_per_L|, |b_per_L|) — the factor
// you multiply Cartesian tip velocity/accel by to get the peak motor
// velocity/accel. It's 1 for pure X/Y, √2 for ±45°, and this holds for every
// valid CoreXY layout.

// Determinant of the mixing matrix. |det| == 2 for any valid CoreXY layout;
// it's a compile-time constant, so the divisions below fold to multiplies.
inline constexpr float corexy_det() {
    return COREXY_M1_X * COREXY_M2_Y - COREXY_M1_Y * COREXY_M2_X;
}

inline void cartesian_to_motor(float x, float y, float *a, float *b) {
    *a = COREXY_M1_X * x + COREXY_M1_Y * y;
    *b = COREXY_M2_X * x + COREXY_M2_Y * y;
}

inline void motor_to_cartesian(float a, float b, float *x, float *y) {
    const float inv_det = 1.0f / corexy_det();
    // Standard 2x2 inverse: [x;y] = (1/det) * [ m2y -m1y; -m2x m1x ] * [a;b]
    *x = ( COREXY_M2_Y * a - COREXY_M1_Y * b) * inv_det;
    *y = (-COREXY_M2_X * a + COREXY_M1_X * b) * inv_det;
}

// Direction-dependent motor load. Absolute values make this invariant under
// any sign flip in the layout — the magnitude is the same either way.
inline float motor_load_for_unit_dir(float ux, float uy) {
    float a = fabsf(COREXY_M1_X * ux + COREXY_M1_Y * uy);
    float b = fabsf(COREXY_M2_X * ux + COREXY_M2_Y * uy);
    return (a > b) ? a : b;
}
