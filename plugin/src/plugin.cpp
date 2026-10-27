// ETS2 Phone Nav — телеметричний плагін для ETS2/ATS (macOS x86_64, Windows x64).
//
// Збирає канали та конфігурації SCS SDK у локальну структуру і наприкінці
// кожного кадру публікує її у файл, відображений у пам'ять (seqlock — див. shm_layout.h):
//   macOS:   /tmp/ets2-phone-nav.shm                         (POSIX mmap)
//   Windows: %LOCALAPPDATA%\ets2-phone-nav\ets2-phone-nav.shm      (CreateFileMapping)
// Companion читає цей файл звичайним читанням: і на macOS, і на Windows
// відображення файлу й файловий ввід-вивід когерентні (спільний кеш сторінок).
// Жодної мережі й потоків: усе працює в головному потоці гри, як вимагає SDK.

#ifdef _WIN32
#  define _CRT_SECURE_NO_WARNINGS // _wgetenv/_snwprintf тут безпечні: довжини обмежені явно
#endif

#include <atomic>
#include <stdio.h>
#include <string.h>

#ifdef _WIN32
#  define WIN32_LEAN_AND_MEAN
#  include <windows.h>
#else
#  include <fcntl.h>
#  include <sys/mman.h>
#  include <unistd.h>
#endif

#include "scssdk_telemetry.h"
#include "eurotrucks2/scssdk_eut2.h"
#include "amtrucks/scssdk_ats.h"
#include "common/scssdk_telemetry_common_configs.h"
#include "common/scssdk_telemetry_common_channels.h"
#include "common/scssdk_telemetry_common_gameplay_events.h"
#include "common/scssdk_telemetry_job_common_channels.h"
#include "common/scssdk_telemetry_truck_common_channels.h"

#include "shm_layout.h"

#ifdef _WIN32
#  define TRUCKNAV_EXPORT extern "C" __declspec(dllexport)
#else
#  define TRUCKNAV_EXPORT extern "C" __attribute__((visibility("default")))
#endif

static scs_log_t game_log = NULL;
static trucknav_shm_t *shm = NULL;
static char shm_path[512] = ""; // UTF-8, для логу гри
static trucknav_body_t cur;

static void log_line(const char *msg)
{
	if (game_log) {
		game_log(SCS_LOG_TYPE_message, msg);
	}
}

// Копіює рядок у буфер фіксованого розміру, не розрізаючи UTF-8 посеред символу.
static void copy_str(char *dst, size_t size, const char *src)
{
	if (!src) {
		dst[0] = '\0';
		return;
	}
	size_t n = strlen(src);
	if (n >= size) {
		n = size - 1;
		while (n > 0 && (static_cast<unsigned char>(src[n]) & 0xC0) == 0x80) {
			--n;
		}
	}
	memcpy(dst, src, n);
	dst[n] = '\0';
}

#define COPY_STR(field, src) copy_str(cur.field, sizeof(cur.field), (src))

static void publish(void)
{
	if (!shm) {
		return;
	}
	const uint32_t s = shm->seq;
	shm->seq = s + 1;
	std::atomic_thread_fence(std::memory_order_seq_cst);
	memcpy(&shm->body, &cur, sizeof(cur));
	std::atomic_thread_fence(std::memory_order_seq_cst);
	shm->seq = s + 2;
	shm->seq_end = s + 2;
}

static void init_header(void)
{
	shm->magic = TRUCKNAV_MAGIC;
	shm->version = TRUCKNAV_VERSION;
}

#ifdef _WIN32

static HANDLE shm_file = INVALID_HANDLE_VALUE;
static HANDLE shm_mapping = NULL;

static bool open_shm(void)
{
	const wchar_t *local = _wgetenv(L"LOCALAPPDATA");
	if (!local) {
		return false;
	}
	wchar_t dir[MAX_PATH], path[MAX_PATH];
	_snwprintf(dir, MAX_PATH, L"%ls\\ets2-phone-nav", local);
	dir[MAX_PATH - 1] = L'\0';
	_snwprintf(path, MAX_PATH, L"%ls\\ets2-phone-nav.shm", dir);
	path[MAX_PATH - 1] = L'\0';
	CreateDirectoryW(dir, NULL); // уже існує — теж добре
	WideCharToMultiByte(CP_UTF8, 0, path, -1, shm_path, sizeof(shm_path), NULL, NULL);

	// FILE_SHARE_* — щоб companion міг читати файл, поки гра тримає його відкритим
	shm_file = CreateFileW(path, GENERIC_READ | GENERIC_WRITE,
		FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
	if (shm_file == INVALID_HANDLE_VALUE) {
		return false;
	}
	// розмір мапінгу сам розширює файл до sizeof(trucknav_shm_t)
	shm_mapping = CreateFileMappingW(shm_file, NULL, PAGE_READWRITE, 0, sizeof(trucknav_shm_t), NULL);
	if (!shm_mapping) {
		CloseHandle(shm_file);
		shm_file = INVALID_HANDLE_VALUE;
		return false;
	}
	void *p = MapViewOfFile(shm_mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(trucknav_shm_t));
	if (!p) {
		CloseHandle(shm_mapping);
		CloseHandle(shm_file);
		shm_mapping = NULL;
		shm_file = INVALID_HANDLE_VALUE;
		return false;
	}
	shm = static_cast<trucknav_shm_t *>(p);
	init_header();
	return true;
}

static void close_shm(void)
{
	if (shm) {
		FlushViewOfFile(shm, sizeof(trucknav_shm_t));
		UnmapViewOfFile(shm);
		shm = NULL;
	}
	if (shm_mapping) {
		CloseHandle(shm_mapping);
		shm_mapping = NULL;
	}
	if (shm_file != INVALID_HANDLE_VALUE) {
		CloseHandle(shm_file);
		shm_file = INVALID_HANDLE_VALUE;
	}
}

#else // POSIX (macOS)

static int shm_fd = -1;

static bool open_shm(void)
{
	snprintf(shm_path, sizeof(shm_path), "%s", "/tmp/ets2-phone-nav.shm");
	shm_fd = open(shm_path, O_RDWR | O_CREAT, 0644);
	if (shm_fd < 0) {
		return false;
	}
	if (ftruncate(shm_fd, sizeof(trucknav_shm_t)) != 0) {
		close(shm_fd);
		shm_fd = -1;
		return false;
	}
	void *p = mmap(NULL, sizeof(trucknav_shm_t), PROT_READ | PROT_WRITE, MAP_SHARED, shm_fd, 0);
	if (p == MAP_FAILED) {
		close(shm_fd);
		shm_fd = -1;
		return false;
	}
	shm = static_cast<trucknav_shm_t *>(p);
	init_header();
	return true;
}

static void close_shm(void)
{
	if (shm) {
		munmap(shm, sizeof(trucknav_shm_t));
		shm = NULL;
	}
	if (shm_fd >= 0) {
		close(shm_fd);
		shm_fd = -1;
	}
}

#endif

// --- канали ---

static SCSAPI_VOID store_float(const scs_string_t, const scs_u32_t, const scs_value_t *const value, const scs_context_t context)
{
	*static_cast<float *>(context) = value ? value->value_float.value : 0.0f;
}

static SCSAPI_VOID store_s32(const scs_string_t, const scs_u32_t, const scs_value_t *const value, const scs_context_t context)
{
	*static_cast<int32_t *>(context) = value ? value->value_s32.value : 0;
}

static SCSAPI_VOID store_u32(const scs_string_t, const scs_u32_t, const scs_value_t *const value, const scs_context_t context)
{
	*static_cast<uint32_t *>(context) = value ? value->value_u32.value : 0;
}

static SCSAPI_VOID store_bool(const scs_string_t, const scs_u32_t, const scs_value_t *const value, const scs_context_t context)
{
	*static_cast<uint32_t *>(context) = (value && value->value_bool.value) ? 1 : 0;
}

static SCSAPI_VOID store_placement(const scs_string_t, const scs_u32_t, const scs_value_t *const value, const scs_context_t)
{
	if (!value) {
		return;
	}
	const scs_value_dplacement_t &p = value->value_dplacement;
	cur.pos_x = p.position.x;
	cur.pos_y = p.position.y;
	cur.pos_z = p.position.z;
	cur.heading = p.orientation.heading;
	cur.pitch = p.orientation.pitch;
}

// --- події ---

static SCSAPI_VOID on_frame_end(const scs_event_t, const void *const, const scs_context_t)
{
	publish();
}

static SCSAPI_VOID on_pause(const scs_event_t event, const void *const, const scs_context_t)
{
	cur.paused = (event == SCS_TELEMETRY_EVENT_paused) ? 1 : 0;
	publish();
}

static void read_truck_config(const scs_named_value_t *a)
{
	for (; a->name; ++a) {
		if (strcmp(a->name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_brand) == 0) COPY_STR(truck_brand, a->value.value_string.value);
		else if (strcmp(a->name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_name) == 0) COPY_STR(truck_name, a->value.value_string.value);
		else if (strcmp(a->name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_fuel_capacity) == 0) cur.fuel_capacity = a->value.value_float.value;
	}
}

static void read_job_config(const scs_named_value_t *a)
{
	cur.job_active = a->name ? 1 : 0;
	cur.job_income = 0;
	cur.job_delivery_time = 0;
	cur.job_planned_km = 0;
	cur.job_cargo_mass = 0;
	cur.job_cargo_units = 0;
	cur.job_special = 0;
	cur.job_cargo[0] = cur.job_src_city[0] = cur.job_src_company[0] = cur.job_dst_city[0] = cur.job_dst_company[0] = '\0';
	cur.job_src_city_id[0] = cur.job_src_company_id[0] = cur.job_dst_city_id[0] = cur.job_dst_company_id[0] = '\0';

	for (; a->name; ++a) {
		const scs_value_t &v = a->value;
		if (strcmp(a->name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_cargo) == 0) COPY_STR(job_cargo, v.value_string.value);
		else if (strcmp(a->name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_source_city) == 0) COPY_STR(job_src_city, v.value_string.value);
		else if (strcmp(a->name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_source_company) == 0) COPY_STR(job_src_company, v.value_string.value);
		else if (strcmp(a->name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_destination_city) == 0) COPY_STR(job_dst_city, v.value_string.value);
		else if (strcmp(a->name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_destination_company) == 0) COPY_STR(job_dst_company, v.value_string.value);
		else if (strcmp(a->name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_source_city_id) == 0) COPY_STR(job_src_city_id, v.value_string.value);
		else if (strcmp(a->name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_source_company_id) == 0) COPY_STR(job_src_company_id, v.value_string.value);
		else if (strcmp(a->name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_destination_city_id) == 0) COPY_STR(job_dst_city_id, v.value_string.value);
		else if (strcmp(a->name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_destination_company_id) == 0) COPY_STR(job_dst_company_id, v.value_string.value);
		else if (strcmp(a->name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_income) == 0) cur.job_income = v.value_u64.value;
		else if (strcmp(a->name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_delivery_time) == 0) cur.job_delivery_time = v.value_u32.value;
		else if (strcmp(a->name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_planned_distance_km) == 0) cur.job_planned_km = v.value_u32.value;
		else if (strcmp(a->name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_cargo_mass) == 0) cur.job_cargo_mass = v.value_float.value;
		else if (strcmp(a->name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_cargo_unit_count) == 0) cur.job_cargo_units = v.value_u32.value;
		else if (strcmp(a->name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_special_job) == 0) cur.job_special = v.value_bool.value ? 1 : 0;
	}
}

static SCSAPI_VOID on_configuration(const scs_event_t, const void *const event_info, const scs_context_t)
{
	const scs_telemetry_configuration_t *const info = static_cast<const scs_telemetry_configuration_t *>(event_info);
	if (strcmp(info->id, SCS_TELEMETRY_CONFIG_truck) == 0) read_truck_config(info->attributes);
	else if (strcmp(info->id, SCS_TELEMETRY_CONFIG_job) == 0) read_job_config(info->attributes);
	else return;
	publish();
}

static SCSAPI_VOID on_gameplay(const scs_event_t, const void *const event_info, const scs_context_t)
{
	const scs_telemetry_gameplay_event_t *const info = static_cast<const scs_telemetry_gameplay_event_t *>(event_info);
	if (strcmp(info->id, SCS_TELEMETRY_GAMEPLAY_EVENT_job_delivered) != 0 &&
	    strcmp(info->id, SCS_TELEMETRY_GAMEPLAY_EVENT_job_cancelled) != 0 &&
	    strcmp(info->id, SCS_TELEMETRY_GAMEPLAY_EVENT_player_fined) != 0 &&
	    strcmp(info->id, SCS_TELEMETRY_GAMEPLAY_EVENT_player_tollgate_paid) != 0) {
		return;
	}
	cur.event_revenue = 0;
	cur.event_xp = 0;
	cur.event_detail[0] = '\0';
	for (const scs_named_value_t *a = info->attributes; a->name; ++a) {
		if (strcmp(a->name, SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_revenue) == 0) cur.event_revenue = a->value.value_s64.value;
		else if (strcmp(a->name, SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_cancel_penalty) == 0) cur.event_revenue = -a->value.value_s64.value;
		else if (strcmp(a->name, SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_fine_amount) == 0) cur.event_revenue = -a->value.value_s64.value;
		else if (strcmp(a->name, SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_pay_amount) == 0) cur.event_revenue = -a->value.value_s64.value;
		else if (strcmp(a->name, SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_fine_offence) == 0) COPY_STR(event_detail, a->value.value_string.value);
		else if (strcmp(a->name, SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_earned_xp) == 0) cur.event_xp = a->value.value_s32.value;
	}
	COPY_STR(event_id, info->id);
	cur.event_seq++;
	publish();
}

// --- init / shutdown ---

TRUCKNAV_EXPORT SCSAPI_RESULT scs_telemetry_init(const scs_u32_t version, const scs_telemetry_init_params_t *const params)
{
	if (version != SCS_TELEMETRY_VERSION_1_01) {
		return SCS_RESULT_unsupported;
	}

	const scs_telemetry_init_params_v101_t *const p = static_cast<const scs_telemetry_init_params_v101_t *>(params);
	game_log = p->common.log;

	memset(&cur, 0, sizeof(cur));
	cur.paused = 1;
	COPY_STR(game_id, p->common.game_id);
	COPY_STR(game_name, p->common.game_name);
	cur.game_version = p->common.game_version;

	char msg[256];
	if (!open_shm()) {
		snprintf(msg, sizeof(msg), "[ets2-phone-nav] cannot open %s", shm_path[0] ? shm_path : "shared memory file");
		log_line(msg);
		return SCS_RESULT_generic_error;
	}

	p->register_for_event(SCS_TELEMETRY_EVENT_frame_end, on_frame_end, NULL);
	p->register_for_event(SCS_TELEMETRY_EVENT_paused, on_pause, NULL);
	p->register_for_event(SCS_TELEMETRY_EVENT_started, on_pause, NULL);
	p->register_for_event(SCS_TELEMETRY_EVENT_configuration, on_configuration, NULL);
	p->register_for_event(SCS_TELEMETRY_EVENT_gameplay, on_gameplay, NULL);

	struct channel_t {
		const char *name;
		scs_value_type_t type;
		scs_telemetry_channel_callback_t cb;
		void *dst;
	};
	const channel_t channels[] = {
		{ SCS_TELEMETRY_CHANNEL_game_time,                     SCS_VALUE_TYPE_u32,        store_u32,       &cur.game_time },
		{ SCS_TELEMETRY_CHANNEL_next_rest_stop,                SCS_VALUE_TYPE_s32,        store_s32,       &cur.next_rest_stop },
		{ SCS_TELEMETRY_CHANNEL_local_scale,                   SCS_VALUE_TYPE_float,      store_float,     &cur.local_scale },
		{ SCS_TELEMETRY_TRUCK_CHANNEL_world_placement,         SCS_VALUE_TYPE_dplacement, store_placement, NULL },
		{ SCS_TELEMETRY_TRUCK_CHANNEL_speed,                   SCS_VALUE_TYPE_float,      store_float,     &cur.speed },
		{ SCS_TELEMETRY_TRUCK_CHANNEL_cruise_control,          SCS_VALUE_TYPE_float,      store_float,     &cur.cruise },
		{ SCS_TELEMETRY_TRUCK_CHANNEL_engine_rpm,              SCS_VALUE_TYPE_float,      store_float,     &cur.rpm },
		{ SCS_TELEMETRY_TRUCK_CHANNEL_displayed_gear,          SCS_VALUE_TYPE_s32,        store_s32,       &cur.gear },
		{ SCS_TELEMETRY_TRUCK_CHANNEL_fuel,                    SCS_VALUE_TYPE_float,      store_float,     &cur.fuel },
		{ SCS_TELEMETRY_TRUCK_CHANNEL_fuel_range,              SCS_VALUE_TYPE_float,      store_float,     &cur.fuel_range },
		{ SCS_TELEMETRY_TRUCK_CHANNEL_fuel_average_consumption, SCS_VALUE_TYPE_float,     store_float,     &cur.fuel_avg },
		{ SCS_TELEMETRY_TRUCK_CHANNEL_fuel_warning,            SCS_VALUE_TYPE_bool,       store_bool,      &cur.fuel_warning },
		{ SCS_TELEMETRY_TRUCK_CHANNEL_parking_brake,           SCS_VALUE_TYPE_bool,       store_bool,      &cur.parking_brake },
		{ SCS_TELEMETRY_TRUCK_CHANNEL_odometer,                SCS_VALUE_TYPE_float,      store_float,     &cur.odometer },
		{ SCS_TELEMETRY_TRUCK_CHANNEL_wear_engine,             SCS_VALUE_TYPE_float,      store_float,     &cur.wear_engine },
		{ SCS_TELEMETRY_TRUCK_CHANNEL_wear_transmission,       SCS_VALUE_TYPE_float,      store_float,     &cur.wear_transmission },
		{ SCS_TELEMETRY_TRUCK_CHANNEL_wear_cabin,              SCS_VALUE_TYPE_float,      store_float,     &cur.wear_cabin },
		{ SCS_TELEMETRY_TRUCK_CHANNEL_wear_chassis,            SCS_VALUE_TYPE_float,      store_float,     &cur.wear_chassis },
		{ SCS_TELEMETRY_TRUCK_CHANNEL_wear_wheels,             SCS_VALUE_TYPE_float,      store_float,     &cur.wear_wheels },
		{ SCS_TELEMETRY_TRUCK_CHANNEL_navigation_distance,     SCS_VALUE_TYPE_float,      store_float,     &cur.nav_distance },
		{ SCS_TELEMETRY_TRUCK_CHANNEL_navigation_time,         SCS_VALUE_TYPE_float,      store_float,     &cur.nav_time },
		{ SCS_TELEMETRY_TRUCK_CHANNEL_navigation_speed_limit,  SCS_VALUE_TYPE_float,      store_float,     &cur.nav_speed_limit },
		{ SCS_TELEMETRY_JOB_CHANNEL_cargo_damage,              SCS_VALUE_TYPE_float,      store_float,     &cur.job_cargo_damage },
	};
	int failed = 0;
	for (const channel_t &c : channels) {
		if (p->register_for_channel(c.name, SCS_U32_NIL, c.type, SCS_TELEMETRY_CHANNEL_FLAG_none, c.cb, c.dst) != SCS_RESULT_ok) {
			snprintf(msg, sizeof(msg), "[ets2-phone-nav] channel unavailable: %s", c.name);
			log_line(msg);
			++failed;
		}
	}

	snprintf(msg, sizeof(msg),
		"[ets2-phone-nav] ready: game_id=%s game_version=%u.%u api=%u.%u shm=%s (%u bytes) channels_failed=%d",
		cur.game_id,
		SCS_GET_MAJOR_VERSION(cur.game_version), SCS_GET_MINOR_VERSION(cur.game_version),
		SCS_GET_MAJOR_VERSION(version), SCS_GET_MINOR_VERSION(version),
		shm_path, (unsigned)sizeof(trucknav_shm_t), failed);
	log_line(msg);

	publish();
	return SCS_RESULT_ok;
}

TRUCKNAV_EXPORT SCSAPI_VOID scs_telemetry_shutdown(void)
{
	cur.paused = 1;
	publish();
	close_shm();
	log_line("[ets2-phone-nav] shutdown");
	game_log = NULL;
}
