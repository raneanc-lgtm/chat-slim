// Ponte nativa: inicia o Node.js embarcado (nodejs-mobile) com os argumentos
// recebidos do Java e manda stdout/stderr do Node pro logcat (tag CHATSLIM-NODE).
#include <jni.h>
#include <cstdlib>
#include <cstring>
#include <pthread.h>
#include <unistd.h>
#include <android/log.h>
#include <string>
#include <vector>

#include "node.h"

static const char *TAG = "CHATSLIM-NODE";
static int pipe_out[2];
static int pipe_err[2];

static void *ler_pipe(void *arg) {
    int fd = *(int *)arg;
    int prio = (fd == pipe_err[0]) ? ANDROID_LOG_ERROR : ANDROID_LOG_INFO;
    char buf[2048];
    ssize_t n;
    while ((n = read(fd, buf, sizeof(buf) - 1)) > 0) {
        if (buf[n - 1] == '\n') --n;
        buf[n] = 0;
        __android_log_write(prio, TAG, buf);
    }
    return nullptr;
}

static void redirecionar_saida() {
    setvbuf(stdout, nullptr, _IONBF, 0);
    setvbuf(stderr, nullptr, _IONBF, 0);
    pipe(pipe_out);
    pipe(pipe_err);
    dup2(pipe_out[1], STDOUT_FILENO);
    dup2(pipe_err[1], STDERR_FILENO);
    pthread_t t1, t2;
    pthread_create(&t1, nullptr, ler_pipe, &pipe_out[0]);
    pthread_detach(t1);
    pthread_create(&t2, nullptr, ler_pipe, &pipe_err[0]);
    pthread_detach(t2);
}

extern "C" JNIEXPORT jint JNICALL
Java_br_com_slimcreative_chatslim_NodeRunner_startNode(JNIEnv *env, jclass, jobjectArray args) {
    redirecionar_saida();

    jsize argc = env->GetArrayLength(args);
    std::vector<std::string> valores;
    size_t total = 0;
    for (jsize i = 0; i < argc; i++) {
        auto js = (jstring)env->GetObjectArrayElement(args, i);
        const char *c = env->GetStringUTFChars(js, nullptr);
        valores.emplace_back(c);
        env->ReleaseStringUTFChars(js, c);
        env->DeleteLocalRef(js);
        total += valores.back().size() + 1;
    }

    // o libuv exige que os argumentos fiquem em memória contígua
    char *bloco = (char *)calloc(total, 1);
    std::vector<char *> argv(argc + 1, nullptr);
    char *pos = bloco;
    for (jsize i = 0; i < argc; i++) {
        memcpy(pos, valores[i].c_str(), valores[i].size());
        argv[i] = pos;
        pos += valores[i].size() + 1;
    }

    return (jint)node::Start((int)argc, argv.data());
}
