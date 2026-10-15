/* SQLCipher provider adapter. Cryptographic operations are Windows CNG calls;
 * SQLCipher's page format, authentication, salt and key scheduling stay upstream.
 * This file is original WorkTrace code, not a cryptographic primitive implementation. */
#include <windows.h>
#include <bcrypt.h>
#include <string.h>
#include "sqlite3.h"
#include "sqlcipher.h"

typedef struct { BCRYPT_ALG_HANDLE aes, hash[3]; } cng_ctx;
static int ok(void *ctx) { (void)ctx; return SQLITE_OK; }
static const char *name(void *ctx) { (void)ctx; return "Windows CNG"; }
static const char *version(void *ctx) { (void)ctx; return "system-bcrypt/1"; }
static const char *cipher_name(void *ctx) { (void)ctx; return "aes-256-cbc"; }
static int key_size(void *ctx) { (void)ctx; return 32; }
static int block_size(void *ctx) { (void)ctx; return 16; }
static int hmac_size(void *ctx,int algorithm) { (void)ctx; return algorithm==0?20:algorithm==1?32:algorithm==2?64:0; }
static int fips(void *ctx) { (void)ctx; return 0; } /* No certification claim. */
static int add_random(void *ctx,void *data,int length) { (void)ctx;(void)data;(void)length; return SQLITE_OK; }
static int random_bytes(void *ctx,void *data,int length) { (void)ctx;return length>=0&&BCryptGenRandom(NULL,data,(ULONG)length,BCRYPT_USE_SYSTEM_PREFERRED_RNG)>=0?SQLITE_OK:SQLITE_ERROR; }
static int free_ctx(void **value) {
    cng_ctx *ctx=*value;if(!ctx)return SQLITE_OK;
    if(ctx->aes)BCryptCloseAlgorithmProvider(ctx->aes,0);
    for(int i=0;i<3;i++)if(ctx->hash[i])BCryptCloseAlgorithmProvider(ctx->hash[i],0);
    SecureZeroMemory(ctx,sizeof(*ctx));sqlite3_free(ctx);*value=NULL;return SQLITE_OK;
}
static int init_ctx(void **value) {
    cng_ctx *ctx=sqlite3_malloc(sizeof(*ctx));if(!ctx)return SQLITE_NOMEM;memset(ctx,0,sizeof(*ctx));*value=ctx;
    if(BCryptOpenAlgorithmProvider(&ctx->aes,BCRYPT_AES_ALGORITHM,NULL,0)<0||BCryptSetProperty(ctx->aes,BCRYPT_CHAINING_MODE,(PUCHAR)BCRYPT_CHAIN_MODE_CBC,sizeof(BCRYPT_CHAIN_MODE_CBC),0)<0)goto error;
    const wchar_t *names[3]={BCRYPT_SHA1_ALGORITHM,BCRYPT_SHA256_ALGORITHM,BCRYPT_SHA512_ALGORITHM};
    for(int i=0;i<3;i++)if(BCryptOpenAlgorithmProvider(&ctx->hash[i],names[i],NULL,BCRYPT_ALG_HANDLE_HMAC_FLAG)<0)goto error;
    return SQLITE_OK;
error: free_ctx(value);return SQLITE_ERROR;
}
/* Every context has identical immutable algorithm settings and owns its handles. */
static int copy_ctx(void *target,void *source) { (void)target;(void)source;return SQLITE_OK; }
static int cmp_ctx(void *a,void *b) { (void)a;(void)b;return 1; }
static int hmac(void *value,int algorithm,unsigned char *key,int key_len,unsigned char *a,int a_len,unsigned char *b,int b_len,unsigned char *out) {
    cng_ctx *ctx=value;BCRYPT_HASH_HANDLE handle=NULL;int result=SQLITE_ERROR;ULONG size=0,got=0;PUCHAR object=NULL;
    if(algorithm<0||algorithm>2||key_len<0||a_len<0||b_len<0)return result;
    if(BCryptGetProperty(ctx->hash[algorithm],BCRYPT_OBJECT_LENGTH,(PUCHAR)&size,sizeof(size),&got,0)<0||size>1024*1024)return result;
    object=sqlite3_malloc(size);if(!object)return SQLITE_NOMEM;
    if(BCryptCreateHash(ctx->hash[algorithm],&handle,object,size,key,key_len,0)<0)goto done;
    if(a_len&&BCryptHashData(handle,a,a_len,0)<0)goto done;
    if(b_len&&BCryptHashData(handle,b,b_len,0)<0)goto done;
    if(BCryptFinishHash(handle,out,hmac_size(ctx,algorithm),0)<0)goto done;
    result=SQLITE_OK;
done: if(handle)BCryptDestroyHash(handle);SecureZeroMemory(object,size);sqlite3_free(object);return result;
}
static int kdf(void *value,int algorithm,const unsigned char *pass,int pass_len,unsigned char *salt,int salt_len,int iterations,int key_len,unsigned char *key) {
    cng_ctx *ctx=value;if(algorithm<0||algorithm>2||pass_len<0||salt_len<0||iterations<=0||key_len<=0)return SQLITE_ERROR;
    return BCryptDeriveKeyPBKDF2(ctx->hash[algorithm],(PUCHAR)pass,pass_len,salt,salt_len,(ULONGLONG)iterations,key,key_len,0)>=0?SQLITE_OK:SQLITE_ERROR;
}
static int cipher(void *value,int mode,unsigned char *key,int key_len,unsigned char *iv,unsigned char *input,int length,unsigned char *out) {
    cng_ctx *ctx=value;BCRYPT_KEY_HANDLE handle=NULL;ULONG size=0,got=0;PUCHAR object=NULL;unsigned char local_iv[16];int result=SQLITE_ERROR;
    if(key_len!=32||length<0||length%16!=0||(mode!=0&&mode!=1))return result;
    if(BCryptGetProperty(ctx->aes,BCRYPT_OBJECT_LENGTH,(PUCHAR)&size,sizeof(size),&got,0)<0||size>1024*1024)return result;
    object=sqlite3_malloc(size);if(!object)return SQLITE_NOMEM;memcpy(local_iv,iv,16);
    if(BCryptGenerateSymmetricKey(ctx->aes,&handle,object,size,key,key_len,0)<0)goto done;
    NTSTATUS status=mode?BCryptEncrypt(handle,input,length,NULL,local_iv,16,out,length,&got,0):BCryptDecrypt(handle,input,length,NULL,local_iv,16,out,length,&got,0);
    if(status>=0&&got==(ULONG)length)result=SQLITE_OK;
done: if(handle)BCryptDestroyKey(handle);SecureZeroMemory(object,size);sqlite3_free(object);SecureZeroMemory(local_iv,sizeof(local_iv));return result;
}
int sqlcipher_custom_setup(sqlcipher_provider *p) {
    memset(p,0,sizeof(*p));p->activate=ok;p->deactivate=ok;p->get_provider_name=name;p->get_provider_version=version;
    p->random=random_bytes;p->add_random=add_random;p->hmac=hmac;p->kdf=kdf;p->cipher=cipher;p->get_cipher=cipher_name;
    p->get_key_sz=key_size;p->get_iv_sz=block_size;p->get_block_sz=block_size;p->get_hmac_sz=hmac_size;
    p->ctx_copy=copy_ctx;p->ctx_cmp=cmp_ctx;p->ctx_init=init_ctx;p->ctx_free=free_ctx;p->fips_status=fips;return SQLITE_OK;
}
