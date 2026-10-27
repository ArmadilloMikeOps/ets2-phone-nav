// Розкладка спільної пам'яті /tmp/ets2-phone-nav.shm.
// Єдине джерело правди: X-макрос нижче генерує і C-структуру, і build/layout.json,
// з якого companion бере зсуви полів. Поле додається тут — і більше ніде.
//
// Протокол узгодженості (seqlock):
//   writer: seq = s+1 (непарне) → копіює тіло → seq = s+2, seq_end = s+2
//   reader: приймає кадр, лише якщо seq парний і seq == seq_end.

#pragma once
#include <stdint.h>

#define TRUCKNAV_MAGIC   0x564E4B54u   // "TKNV"
#define TRUCKNAV_VERSION 4u

// X(тип у C, ім'я, тип у JS) — скаляр; S(ім'я, довжина) — рядок UTF-8 з нулем у кінці
#define TRUCKNAV_FIELDS(X, S) \
	/* --- гра --- */ \
	S(game_id,              16) \
	S(game_name,            64) \
	X(uint32_t, game_version,         u32) \
	X(uint32_t, paused,               u32) \
	X(uint32_t, game_time,            u32)  /* хвилини ігрового часу від початку */ \
	X(int32_t,  next_rest_stop,       s32)  /* хвилини до обов'язкового відпочинку */ \
	X(float,    local_scale,          f32) \
	X(uint32_t, _pad0,                u32) \
	/* --- світ --- */ \
	X(double,   pos_x,                f64) \
	X(double,   pos_y,                f64) \
	X(double,   pos_z,                f64) \
	X(float,    heading,              f32)  /* частки оберту 0..1 */ \
	X(float,    pitch,                f32) \
	/* --- вантажівка --- */ \
	X(float,    speed,                f32)  /* м/с */ \
	X(float,    cruise,               f32)  /* м/с, 0 = вимкнено */ \
	X(float,    rpm,                  f32) \
	X(int32_t,  gear,                 s32)  /* displayed gear: >0 вперед, 0 N, <0 R */ \
	X(float,    fuel,                 f32)  /* л */ \
	X(float,    fuel_capacity,        f32)  /* л */ \
	X(float,    fuel_range,           f32)  /* км */ \
	X(float,    fuel_avg,             f32)  /* л/км */ \
	X(uint32_t, fuel_warning,         u32) \
	X(uint32_t, parking_brake,        u32) \
	X(uint32_t, blinker_left,         u32)  /* поворотник увімкнено (а не «лампа зараз світить») */ \
	X(uint32_t, blinker_right,        u32) \
	X(uint32_t, hazard,               u32)  /* аварійка */ \
	X(float,    odometer,             f32)  /* км */ \
	X(float,    wear_engine,          f32)  /* 0..1 */ \
	X(float,    wear_transmission,    f32) \
	X(float,    wear_cabin,           f32) \
	X(float,    wear_chassis,         f32) \
	X(float,    wear_wheels,          f32) \
	S(truck_brand,          32) \
	S(truck_name,           64) \
	/* --- навігація (ігровий GPS) --- */ \
	X(float,    nav_distance,         f32)  /* м у масштабі карти */ \
	X(float,    nav_time,             f32)  /* с ігрового часу */ \
	X(float,    nav_speed_limit,      f32)  /* м/с, 0 = немає даних */ \
	/* --- завдання --- */ \
	X(uint32_t, job_active,           u32) \
	X(uint64_t, job_income,           u64) \
	X(uint32_t, job_delivery_time,    u32)  /* абсолютні хвилини ігрового часу */ \
	X(uint32_t, job_planned_km,       u32) \
	X(float,    job_cargo_mass,       f32)  /* кг, загальна */ \
	X(uint32_t, job_cargo_units,      u32) \
	X(uint32_t, job_special,          u32) \
	X(float,    job_cargo_damage,     f32)  /* 0..1 */ \
	S(job_cargo,            96) \
	S(job_src_city,         96) \
	S(job_src_company,      96) \
	S(job_dst_city,         96) \
	S(job_dst_company,      96) \
	S(job_src_city_id,      32)  /* токени для пошуку на карті (cityToken, token у mapdata) */ \
	S(job_src_company_id,   32) \
	S(job_dst_city_id,      32) \
	S(job_dst_company_id,   32) \
	/* --- остання ігрова подія (доставка/скасування) --- */ \
	X(uint32_t, event_seq,            u32) \
	X(uint32_t, _pad1,                u32) \
	X(int64_t,  event_revenue,        s64)  /* дохід (+) або штраф/оплата (−) */ \
	X(int32_t,  event_xp,             s32) \
	S(event_id,             32)  /* job.delivered, job.cancelled, player.fined, player.tollgate.paid */ \
	S(event_detail,         32)  /* для штрафу — fine.offence: crash, speeding, red_signal… */

#define TRUCKNAV_DECLARE(ctype, name, jstype) ctype name;
#define TRUCKNAV_DECLARE_STR(name, len) char name[len];

struct trucknav_body_t {
	TRUCKNAV_FIELDS(TRUCKNAV_DECLARE, TRUCKNAV_DECLARE_STR)
};

struct trucknav_shm_t {
	uint32_t magic;
	uint32_t version;
	uint32_t seq;
	uint32_t _pad;
	trucknav_body_t body;
	uint32_t seq_end;
};
