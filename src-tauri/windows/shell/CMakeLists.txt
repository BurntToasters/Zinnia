cmake_minimum_required(VERSION 3.20)
project(zinnia_shell LANGUAGES CXX RC)

add_library(zinnia_shell SHARED
  dllmain.cpp
  zinnia_shell.rc
)

target_compile_features(zinnia_shell PRIVATE cxx_std_17)
target_compile_definitions(zinnia_shell PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(zinnia_shell PRIVATE shlwapi ole32 shell32)
set_target_properties(zinnia_shell PROPERTIES
  OUTPUT_NAME "zinnia_shell"
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/out"
  LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/out"
  ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/out"
)

if(MSVC)
  target_link_options(zinnia_shell PRIVATE "/DEF:${CMAKE_CURRENT_SOURCE_DIR}/zinnia_shell.def")
endif()
