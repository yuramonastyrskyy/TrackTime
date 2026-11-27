# Tiny native helper for the slow-motion camera (HwTexture.java): puts a camera
# frame (HardwareBuffer) on a GL texture without copying it.
cmake_minimum_required(VERSION 3.18)
project(ttnative C)
add_library(ttnative SHARED hwtexture.c)
target_link_libraries(ttnative EGL GLESv2 dl log)
