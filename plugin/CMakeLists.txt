# Збірка плагіна через CMake — передусім для Windows/MSVC (так збирає CI).
# На macOS простіше `make`, на Mac → Windows — `make windows` (mingw-w64).
#
#   cmake -S plugin -B plugin/build-cmake -A x64
#   cmake --build plugin/build-cmake --config Release
#   → plugin/build/ets2-phone-nav.dll (Windows) або plugin/build/ets2-phone-nav.dylib (macOS)

cmake_minimum_required(VERSION 3.20)
project(ets2_phone_nav CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(ets2-phone-nav SHARED src/plugin.cpp)
if(WIN32)
	target_sources(ets2-phone-nav PRIVATE src/exports.def) # експорти без dllexport (див. exports.def)
endif()
target_include_directories(ets2-phone-nav PRIVATE
	vendor/scs_sdk/include
	vendor/scs_sdk/include/common
	vendor/scs_sdk/include/eurotrucks2
	vendor/scs_sdk/include/amtrucks)
set_target_properties(ets2-phone-nav PROPERTIES PREFIX "")

if(MSVC)
	target_compile_options(ets2-phone-nav PRIVATE /W4 /utf-8)
	# статичний CRT: DLL не потребує окремого Visual C++ Redistributable
	set_property(TARGET ets2-phone-nav PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded")
elseif(APPLE)
	set(CMAKE_OSX_ARCHITECTURES x86_64 CACHE STRING "" FORCE) # гра на Mac — x86_64
	set_target_properties(ets2-phone-nav PROPERTIES SUFFIX ".dylib")
	target_compile_options(ets2-phone-nav PRIVATE -Wall -Wextra)
endif()

# кладемо результат туди ж, де його шукають скрипти встановлення
set_target_properties(ets2-phone-nav PROPERTIES
	RUNTIME_OUTPUT_DIRECTORY_RELEASE ${CMAKE_CURRENT_SOURCE_DIR}/build
	LIBRARY_OUTPUT_DIRECTORY_RELEASE ${CMAKE_CURRENT_SOURCE_DIR}/build
	RUNTIME_OUTPUT_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/build
	LIBRARY_OUTPUT_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/build)

add_executable(layout_dump src/layout_dump.cpp)
