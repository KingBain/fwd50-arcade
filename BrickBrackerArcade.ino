#include <WiFi.h>
#include <DNSServer.h>
#include <ESPmDNS.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <LittleFS.h>

// ===== Access Point config =====
static const char* AP_SSID   = "ConfArcade"; // as requested
static const char* AP_PASS   = "";                   // "" => OPEN network
static const int   AP_CHAN   = 1;

IPAddress apIP(192,168,4,1);
IPAddress apGW(192,168,4,1);
IPAddress apMask(255,255,255,0);

// ===== Captive DNS =====
DNSServer dns;                 // replies to all queries with apIP
const byte DNS_PORT = 53;

// ===== HTTP server =====
AsyncWebServer server(80);

// Utility: set no-cache headers for portal responses
void noCache(AsyncWebServerResponse* res) {
  res->addHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res->addHeader("Pragma", "no-cache");
  res->addHeader("Expires", "0");
}

void setup() {
  Serial.begin(115200);
  delay(200);

  // FS
  if (!LittleFS.begin()) {
    Serial.println("LittleFS mount failed. Did you upload /data?");
    while (true) { delay(1000); }
  }

  // AP
  WiFi.mode(WIFI_MODE_AP);
  WiFi.softAPConfig(apIP, apGW, apMask);
  bool ok = WiFi.softAP(AP_SSID, AP_PASS, AP_CHAN);
  if (!ok) Serial.println("SoftAP start failed!");
  Serial.printf("AP SSID: %s\n", AP_SSID);
  Serial.printf("AP  IP : %s\n", WiFi.softAPIP().toString().c_str());
  if (AP_PASS[0] == '\0') Serial.println("NOTE: Open network (no password).");

  // mDNS (not all clients resolve .local in AP, but harmless if it does)
  if (MDNS.begin("brick")) {
    Serial.println("mDNS: http://brick.local/");
  } else {
    Serial.println("mDNS start failed.");
  }

  // DNS: resolve ALL hostnames to our AP IP (captive behavior)
  dns.start(DNS_PORT, "*", apIP);

  // --- Known OS captive-check endpoints → captive portal ---
  // Android
  server.on("/generate_204", HTTP_GET, [](AsyncWebServerRequest* req){
    auto* r = req->beginResponse(LittleFS, "/captive.html", "text/html");
    noCache(r); req->send(r);
  });
  // Apple / iOS / macOS
  server.on("/hotspot-detect.html", HTTP_GET, [](AsyncWebServerRequest* req){
    auto* r = req->beginResponse(LittleFS, "/captive.html", "text/html");
    noCache(r); req->send(r);
  });
  // Windows
  server.on("/ncsi.txt", HTTP_GET, [](AsyncWebServerRequest* req){
    auto* r = req->beginResponse(200, "text/plain", "Microsoft NCSI");
    noCache(r); req->send(r);
  });
  server.on("/connecttest.txt", HTTP_GET, [](AsyncWebServerRequest* req){
    auto* r = req->beginResponse(200, "text/plain", "Microsoft Connect Test");
    noCache(r); req->send(r);
  });

  // --- Captive landing (default at "/") ---
  server.on("/", HTTP_ANY, [](AsyncWebServerRequest* req){
    auto* r = req->beginResponse(LittleFS, "/captive.html", "text/html");
    noCache(r); req->send(r);
  });

  // --- Game entry: /play serves index.html (kept separate from portal) ---
  server.on("/play", HTTP_ANY, [](AsyncWebServerRequest* req){
    auto* r = req->beginResponse(LittleFS, "/index.html", "text/html");
    // You can cache game assets if you like; portal stays no-cache
    r->addHeader("Cache-Control", "public, max-age=3600");
    req->send(r);
  });

  // --- Static assets (game.js, css, images if any) ---
  server.serveStatic("/", LittleFS, "/")
        .setCacheControl("public, max-age=3600"); // safe for /game.js etc.

  // --- Fallback: everything else goes to captive page ---
  server.onNotFound([](AsyncWebServerRequest* req){
    auto* r = req->beginResponse(LittleFS, "/captive.html", "text/html");
    noCache(r); req->send(r);
  });

  server.begin();
  Serial.println("HTTP server started");
}

void loop() {
  dns.processNextRequest(); // keep answering DNS queries
}
