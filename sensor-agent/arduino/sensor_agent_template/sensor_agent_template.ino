/*
  Sensor agent: Arduino sketch template

  The agent works with any sketch that prints readings over Serial, one line per
  reading cycle. It figures out the sensors from the labels, units and values,
  plus the setup description you type into the dashboard.

  For the most accurate results, print lines like:

      temp_c=23.4,humidity=51,soil_raw=512

  - one "name=value" pair per sensor value, separated by commas
  - put the unit in the name (temp_c, distance_cm) or after the value (23.4 C)
  - use the same names every time
  - print error text when a read fails, e.g. "DHT22 read failed"

  This template reads the analog pins so it runs with no extra libraries.
  Replace or extend it with your own sensors (see the DHT22 example below).
*/

const unsigned long INTERVAL_MS = 2000;  // one reading every 2 seconds

void setup() {
  Serial.begin(9600);                     // must match BAUD in the bridge (default 9600)
  while (!Serial) { }                     // wait for USB on boards like Leonardo / Nano 33
  Serial.println("Sensor agent template started");
}

void loop() {
  int a0 = analogRead(A0);
  int a1 = analogRead(A1);

  Serial.print("a0_raw=");
  Serial.print(a0);
  Serial.print(",a1_raw=");
  Serial.println(a1);

  delay(INTERVAL_MS);
}

/*
  ---- Example: DHT22 temperature/humidity on pin 2 ----
  Install "DHT sensor library" by Adafruit (Library Manager), then:

  #include <DHT.h>
  DHT dht(2, DHT22);

  void setup() {
    Serial.begin(9600);
    dht.begin();
  }

  void loop() {
    float h = dht.readHumidity();
    float t = dht.readTemperature();
    if (isnan(h) || isnan(t)) {
      Serial.println("DHT22 read failed");
    } else {
      Serial.print("temp_c=");   Serial.print(t, 1);
      Serial.print(",humidity="); Serial.print(h, 1);
      Serial.print(",soil_raw="); Serial.println(analogRead(A0));
    }
    delay(2000);
  }
*/
