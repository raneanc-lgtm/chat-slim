cmake_minimum_required(VERSION 3.18.1)
project(chatslim_node)

# libnode vem do nodejs-mobile (baixado no build do GitHub Actions para app/libnode)
set(LIBNODE_DIR ${CMAKE_SOURCE_DIR}/../../../libnode)

add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES
    IMPORTED_LOCATION ${LIBNODE_DIR}/bin/${ANDROID_ABI}/libnode.so)

add_library(chatslim-node SHARED native-lib.cpp)
target_include_directories(chatslim-node PRIVATE ${LIBNODE_DIR}/include/node)

find_library(log-lib log)
target_link_libraries(chatslim-node libnode ${log-lib})
