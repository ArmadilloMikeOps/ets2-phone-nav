# Збірка плагіна ETS2 Phone Nav.
#
#   make            — macOS: build/ets2-phone-nav.dylib (x86_64, бо гра на Mac — x86_64 під Rosetta)
#   make windows    — Windows x64: build/ets2-phone-nav.dll крос-компілятором mingw-w64
#                     (на Mac: brew install mingw-w64; на Windows можна й MSVC — див. CMakeLists.txt)
#   make layout     — ../companion/layout.json: зсуви полів спільної пам'яті для companion
#
# Розкладка однакова на обох системах (лише типи фіксованого розміру), тож layout.json
# спільний і лежить у репозиторії; CI перевіряє, що він не застарів.

SDK := vendor/scs_sdk/include
INCLUDES := -I$(SDK) -I$(SDK)/common -I$(SDK)/eurotrucks2 -I$(SDK)/amtrucks
COMMON := -std=c++17 -O2 -Wall -Wextra $(INCLUDES)

MINGW ?= x86_64-w64-mingw32-g++
LAYOUT := ../companion/layout.json

.PHONY: all mac windows layout clean
all: mac layout

mac: build/ets2-phone-nav.dylib
windows: build/ets2-phone-nav.dll
layout: $(LAYOUT)

build/ets2-phone-nav.dylib: src/plugin.cpp src/shm_layout.h
	@mkdir -p build
	clang++ -arch x86_64 $(COMMON) -fPIC -dynamiclib -install_name @rpath/ets2-phone-nav.dylib -o $@ src/plugin.cpp

# статично лінкуємо рантайм mingw — гра не мусить мати libstdc++-6.dll поруч
build/ets2-phone-nav.dll: src/plugin.cpp src/shm_layout.h src/exports.def
	@mkdir -p build
	$(MINGW) $(COMMON) -shared -static -static-libgcc -static-libstdc++ -o $@ src/plugin.cpp src/exports.def

# layout_dump збираємо під поточну систему: зсуви не залежать від ОС (див. вище)
$(LAYOUT): src/layout_dump.cpp src/shm_layout.h
	@mkdir -p build
	$(CXX) $(COMMON) -o build/layout_dump src/layout_dump.cpp
	./build/layout_dump > $@

clean:
	rm -rf build
