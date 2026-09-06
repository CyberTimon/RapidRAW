use once_cell::sync::Lazy;
use reverse_geocoder::ReverseGeocoder;
use serde::{Deserialize, Serialize};
use std::panic::{AssertUnwindSafe, catch_unwind};

static GEOCODER: Lazy<ReverseGeocoder> = Lazy::new(ReverseGeocoder::new);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoCoordinate {
    path: String,
    latitude: f64,
    longitude: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoLocationResult {
    path: String,
    name: String,
    admin1: String,
    admin2: String,
    country_code: String,
}

fn reverse_geocode_coordinate(coordinate: GeoCoordinate) -> Option<GeoLocationResult> {
    if !coordinate.latitude.is_finite()
        || !coordinate.longitude.is_finite()
        || !(-90.0..=90.0).contains(&coordinate.latitude)
        || !(-180.0..=180.0).contains(&coordinate.longitude)
    {
        return None;
    }

    // reverse_geocoder assumes valid coordinates and may panic for invalid input.
    // Keep the command resilient if the embedded data or an unexpected coordinate
    // ever violates that assumption.
    let result = catch_unwind(AssertUnwindSafe(|| {
        GEOCODER.search((coordinate.latitude, coordinate.longitude))
    }))
    .ok()?;
    let record = result.record;

    Some(GeoLocationResult {
        path: coordinate.path,
        name: record.name.clone(),
        admin1: record.admin1.clone(),
        admin2: record.admin2.clone(),
        country_code: record.cc.clone(),
    })
}

#[tauri::command]
pub async fn reverse_geocode_coordinates(
    coordinates: Vec<GeoCoordinate>,
) -> Result<Vec<GeoLocationResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        coordinates
            .into_iter()
            .filter_map(reverse_geocode_coordinate)
            .collect()
    })
    .await
    .map_err(|error| format!("Failed to reverse geocode coordinates: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reverse_geocodes_valid_coordinates() {
        let result = reverse_geocode_coordinate(GeoCoordinate {
            path: "/photo.jpg".to_string(),
            latitude: 40.7128,
            longitude: -74.006,
        })
        .expect("New York coordinates should resolve");

        assert_eq!(result.path, "/photo.jpg");
        assert_eq!(result.country_code, "US");
        assert!(!result.name.is_empty());
        assert!(!result.admin1.is_empty());
    }

    #[test]
    fn rejects_invalid_coordinates() {
        assert!(
            reverse_geocode_coordinate(GeoCoordinate {
                path: "/photo.jpg".to_string(),
                latitude: 100.0,
                longitude: 0.0,
            })
            .is_none()
        );
    }
}
