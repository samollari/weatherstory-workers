# Weather Story Discord Bot

Hosted on Cloudflare Workers

## Commands:

- `/subscribe <office>`: Subscribes that channel to updates from that office
- `/unsubscribe [office]`: Unsubscribes that channel from all updates or just office-specific updates
- `/getstory <office>`: Gets the current Weather Story from that office one time

## Offices

A map of all offices is available at https://www.weather.gov/srh/nwsoffices. Get the inner HTML of the image map element (selector `map[name=cwa]`). For each `area`, use the following RegEx to pull out the office code and office name: `.+href="https?://www.weather.gov/(p?[a-z]{3}|guam)/?" name="NWS ([\w\s.,/x\-]+)".*`
