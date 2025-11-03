#include <WiFi.h>
#include <DNSServer.h>
#include <ESPmDNS.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <LittleFS.h>

// ===== Access Point config =====
static const char* AP_SSID   = "Arcade"; // as requested
static const char* AP_PASS   = "";           // "" => OPEN network
static const int   AP_CHAN   = 4;

IPAddress apIP(192,168,4,1);
IPAddress apGW(192,168,4,1);
IPAddress apMask(255,255,255,0);

// ===== Captive DNS =====
DNSServer dns;                 // replies to all queries with apIP
const byte DNS_PORT = 53;

// ===== HTTP server =====
AsyncWebServer server(80);

// ---------- Utils ----------
void noCache(AsyncWebServerResponse* res) {
  res->addHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res->addHeader("Pragma", "no-cache");
  res->addHeader("Expires", "0");
}

void logReq(AsyncWebServerRequest* req) {
  String ua = req->getHeader("User-Agent") ? req->getHeader("User-Agent")->value() : "";
  const char* methodStr =
    req->method() == HTTP_GET ? "GET" :
    req->method() == HTTP_POST ? "POST" :
    req->method() == HTTP_OPTIONS ? "OPTIONS" :
    req->method() == HTTP_PUT ? "PUT" :
    req->method() == HTTP_DELETE ? "DELETE" : "OTHER";
  Serial.printf("[HTTP] %s %s UA:%s\n", methodStr, req->url().c_str(), ua.c_str());
}

String portalURL() { return String("http://") + WiFi.softAPIP().toString() + "/"; }

void setup() {
  Serial.begin(115200);
  delay(200);

  // ---------- FS ----------
  if (!LittleFS.begin()) {
    Serial.println("LittleFS mount failed. Did you upload /data (captive.html, index.html, game.js)?");
    while (true) { delay(1000); }
  }

  // ---------- AP ----------
  WiFi.mode(WIFI_MODE_AP);
  WiFi.softAPConfig(apIP, apGW, apMask);
  bool ok = WiFi.softAP(AP_SSID, AP_PASS, AP_CHAN);
  if (!ok) Serial.println("SoftAP start failed!");
  Serial.printf("AP SSID: %s\n", AP_SSID);
  Serial.printf("AP  IP : %s\n", WiFi.softAPIP().toString().c_str());
  if (AP_PASS[0] == '\0') Serial.println("NOTE: Open network (no password).");

  // ---------- mDNS (optional) ----------
  if (MDNS.begin("brick")) {
    Serial.println("mDNS: http://brick.local/");
  } else {
    Serial.println("mDNS start failed.");
  }

  // ---------- DNS (wildcard to AP IP) ----------
  dns.start(DNS_PORT, "*", apIP);
  dns.setTTL(1);
  dns.setErrorReplyCode(DNSReplyCode::NoError);

  // ---------- PROBE HANDLERS ----------

  // ANDROID: Serve a non-204 HTML directly on the probe path (no redirect).
  // Some builds only trigger CNA if the probe URL itself returns 200 with content.
  server.on("/generate_204", HTTP_ANY, [](AsyncWebServerRequest* req){
    logReq(req);
    const char* html =
      "<!doctype html><html><head>"
      "<meta http-equiv='refresh' content='0;url=/'/>"
      "<title>Captive Portal</title></head>"
      "<body>Captive portal detected. <a href='/'>Continue</a></body></html>";
    AsyncWebServerResponse* r = req->beginResponse(200, "text/html", html);
    // Help stubborn stacks: explicit length + no-cache + close.
    r->addHeader("Content-Length", String(strlen(html)));
    noCache(r);
    r->addHeader("Connection", "close");
    req->send(r);
  });

  // Other Android variants seen in the wild
  server.on("/gen_204", HTTP_ANY, [](AsyncWebServerRequest* req){
    logReq(req);
    req->redirect(portalURL()); // try 302 on the alias
  });
  server.on("/204", HTTP_ANY, [](AsyncWebServerRequest* req){
    logReq(req);
    req->redirect(portalURL());
  });
  server.on("/redirect", HTTP_ANY, [](AsyncWebServerRequest* req){
    logReq(req);
    req->redirect(portalURL());
  });

  // iOS / macOS: showing any HTML (not Apple's "Success") triggers CNA
  server.on("/hotspot-detect.html", HTTP_GET, [](AsyncWebServerRequest* req){
    logReq(req);
    auto* r = req->beginResponse(LittleFS, "/captive.html", "text/html");
    noCache(r); req->send(r);
  });

  // Windows
  server.on("/ncsi.txt", HTTP_GET, [](AsyncWebServerRequest* req){
    logReq(req);
    auto* r = req->beginResponse(200, "text/plain", "Microsoft NCSI");
    noCache(r); req->send(r);
  });
  server.on("/connecttest.txt", HTTP_GET, [](AsyncWebServerRequest* req){
    logReq(req);
    auto* r = req->beginResponse(200, "text/plain", "Microsoft Connect Test");
    noCache(r); req->send(r);
  });

  // Firefox
  server.on("/success.txt", HTTP_GET, [](AsyncWebServerRequest* req){
    logReq(req);
    auto* r = req->beginResponse(200, "text/plain", "success");
    noCache(r); req->send(r);
  });

  // Extra OEMs
  server.on("/library/test/success.html", HTTP_GET, [](AsyncWebServerRequest* req){
    logReq(req);
    req->redirect(portalURL());
  });
  server.on("/check_network_status.txt", HTTP_GET, [](AsyncWebServerRequest* req){
    logReq(req);
    auto* r = req->beginResponse(200, "text/plain", "OK");
    noCache(r); req->send(r);
  });

  // ---------- Captive landing ----------
  server.on("/", HTTP_ANY, [](AsyncWebServerRequest* req){
    logReq(req);
    auto* r = req->beginResponse(LittleFS, "/captive.html", "text/html");
    noCache(r); req->send(r);
  });

  // ---------- Game ----------
  server.on("/play", HTTP_ANY, [](AsyncWebServerRequest* req){
    logReq(req);
    auto* r = req->beginResponse(LittleFS, "/index.html", "text/html");
    r->addHeader("Cache-Control", "public, max-age=3600");
    req->send(r);
  });

  // ---------- Static ----------
  server.serveStatic("/", LittleFS, "/")
        .setCacheControl("public, max-age=3600");

  // ---------- Fallback: 511 ----------
  server.onNotFound([](AsyncWebServerRequest* req){
    logReq(req);
    AsyncWebServerResponse* r = req->beginResponse(LittleFS, "/captive.html", "text/html");
    r->setCode(511); // Network Authentication Required
    noCache(r);
    req->send(r);
  });

  server.begin();
  Serial.println("HTTP server started");
}

void loop() {
  dns.processNextRequest();
}
