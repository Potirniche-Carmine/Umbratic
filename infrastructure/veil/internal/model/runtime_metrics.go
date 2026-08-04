package model

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"strconv"
	"strings"
)

type RuntimeMetrics struct {
	PrefixCacheHitRate float64 `json:"prefix_cache_hit_rate"`
	QueueDepth         float64 `json:"queue_depth"`
	Available          bool    `json:"available"`
}

func (c *Client) RuntimeMetrics(ctx context.Context) (RuntimeMetrics, error) {
	if c.mode != ModeServer {
		return RuntimeMetrics{}, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.metricsEndpoint, nil)
	if err != nil {
		return RuntimeMetrics{}, err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return RuntimeMetrics{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return RuntimeMetrics{}, ProviderError{StatusCode: resp.StatusCode}
	}
	return parseRuntimeMetrics(resp.Body)
}

func parseRuntimeMetrics(reader io.Reader) (RuntimeMetrics, error) {
	scanner := bufio.NewScanner(io.LimitReader(reader, 2<<20))
	var hits, queries, queue float64
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		name := strings.SplitN(fields[0], "{", 2)[0]
		value, err := strconv.ParseFloat(fields[len(fields)-1], 64)
		if err != nil {
			continue
		}
		switch name {
		case "vllm:prefix_cache_hits_total", "vllm_prefix_cache_hits_total":
			hits += value
		case "vllm:prefix_cache_queries_total", "vllm_prefix_cache_queries_total":
			queries += value
		case "vllm:num_requests_waiting", "vllm_num_requests_waiting":
			queue += value
		}
	}
	if err := scanner.Err(); err != nil {
		return RuntimeMetrics{}, err
	}
	hitRate := float64(0)
	if queries > 0 {
		hitRate = hits / queries
	}
	return RuntimeMetrics{PrefixCacheHitRate: hitRate, QueueDepth: queue, Available: queries > 0}, nil
}
