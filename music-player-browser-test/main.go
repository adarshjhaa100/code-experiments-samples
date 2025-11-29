package main

import (
	"io" // Import io for copying the response body
	"log"
	"net/http"
	"net/url"
)

// The address where your Go server will listen (e.g., http://localhost:8080)
const listenAddr = ":8080"

func main() {
	// 1. Define a handler function for all requests ("/")
	http.HandleFunc("/", proxyHandler)

	// 2. Start the HTTP server
	log.Printf("Starting flexible CORS proxy server on %s", listenAddr)
	log.Fatal(http.ListenAndServe(listenAddr, nil))
}

// proxyHandler fetches the target URL specified by the 'target' query parameter.
func proxyHandler(w http.ResponseWriter, r *http.Request) {
	// --- 1. SET CORS HEADERS ---
	// This allows access from any origin (e.g., http://127.0.0.1:5500)
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	// Handle CORS preflight requests (OPTIONS method)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	// --- 2. GET TARGET URL FROM QUERY PARAMETER ---
	// r.URL.Query() extracts the map of query parameters (e.g., "?target=...")
	targetURL := r.URL.Query().Get("target")

	if targetURL == "" {
		http.Error(w, "Error: 'target' query parameter is missing.", http.StatusBadRequest)
		log.Println("Request failed: Missing 'target' query parameter.")
		return
	}

	log.Printf("Proxying request to: %s", targetURL)

	// --- 3. MAKE THE REQUEST TO THE TARGET URL ---

	// Check if the target URL is valid
	if _, err := url.ParseRequestURI(targetURL); err != nil {
		http.Error(w, "Error: Invalid target URL format.", http.StatusBadRequest)
		log.Printf("Error: Invalid target URL format: %v", err)
		return
	}

	// Create a new request to the target audio file
	req, err := http.NewRequest(r.Method, targetURL, nil) // Use nil for request body, as we are just forwarding a GET
	if err != nil {
		http.Error(w, "Internal Server Error: Failed to create request", http.StatusInternalServerError)
		log.Printf("Error creating request: %v", err)
		return
	}

	// Execute the request
	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		http.Error(w, "Internal Server Error: Failed to fetch from target URL", http.StatusInternalServerError)
		log.Printf("Error fetching target: %v", err)
		return
	}
	defer resp.Body.Close() // Ensure the response body is closed

	// --- 4. RELAY THE RESPONSE ---

	// Copy all headers (except the original server's ACAO header)
	for name, values := range resp.Header {
		if name != "Access-Control-Allow-Origin" {
			for _, value := range values {
				w.Header().Add(name, value)
			}
		}
	}

	// Set the status code and copy the response body directly
	w.WriteHeader(resp.StatusCode)

	// Use io.Copy for efficient streaming of the response body (the audio file)
	_, err = io.Copy(w, resp.Body)
	if err != nil {
		log.Printf("Error copying response body: %v", err)
	}

	log.Printf("Successfully proxied response from %s", targetURL)
}
